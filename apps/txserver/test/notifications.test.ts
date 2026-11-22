/**
 * Notifications + webhook tests (Slice 4, spec § Notifications).
 *
 * Every event is persisted to the `notification` table **before** delivery is
 * attempted (in-dapp = the persisted rows; webhook = signed POST). The webhook is
 * signed with HMAC-SHA256 over the raw body, at-least-once with retry/backoff,
 * and carries a per-event idempotency key. The HTTP transport is injectable
 * (mocked here), mirroring the oracle client.
 */
import { DataSource } from 'typeorm';
import { createHmac } from 'node:crypto';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import {
  NotificationService,
  type WebhookHttpClient,
} from '../src/notifications/notification.service.js';
import type { NotificationEvent } from '../src/scheduler/scheduler.service.js';

const PARTY = '11'.repeat(20);
const SECRET = 'super-secret';

/** A recording webhook transport. */
function recordingTransport(): {
  client: WebhookHttpClient;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const client: WebhookHttpClient = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return { client, calls };
}

/** A transport that fails the first `failures` attempts, then succeeds. */
function flakyTransport(failures: number): {
  client: WebhookHttpClient;
  attempts: () => number;
} {
  let attempts = 0;
  const client: WebhookHttpClient = async () => {
    attempts += 1;
    if (attempts <= failures) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  return { client, attempts: () => attempts };
}

describe('NotificationService', () => {
  let dataSource: DataSource;
  let notifications: NotificationRepository;
  let endpoints: WebhookEndpointRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Notification, WebhookEndpoint],
      synchronize: true,
    });
    await dataSource.initialize();
    notifications = new NotificationRepository(dataSource.getRepository(Notification));
    endpoints = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const event = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
    type: 'pull_success',
    subscriptionId: 'ff'.repeat(32),
    at: 1_764_000_000,
    data: { txid: 'ab'.repeat(32), periodsSettled: 1n },
    ...over,
  });

  /** Emit with the recipient set to PARTY (the endpoint owner). */
  const emitToParty = (
    service: NotificationService,
    e: NotificationEvent = event(),
  ): Promise<void> => service.emit(e, { recipients: [PARTY] });

  it('persists the event before attempting delivery', async () => {
    let sawRowBeforeDelivery = false;
    const client: WebhookHttpClient = async () => {
      sawRowBeforeDelivery = (await notifications.count()) === 1;
      return { ok: true, status: 200 };
    };
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    await emitToParty(service);
    expect(sawRowBeforeDelivery).toBe(true);
    expect(await notifications.count()).toBe(1);
  });

  it('does not crash when a webhook transport throws', async () => {
    const client: WebhookHttpClient = async () => {
      throw new Error('ECONNREFUSED');
    };
    const service = new NotificationService(notifications, endpoints, client, {
      maxAttempts: 2,
      baseDelayMs: 1,
      sleep: async () => undefined,
    });
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    await expect(emitToParty(service)).resolves.toBeUndefined();
    const row = await notifications.latest();
    expect(row).not.toBeNull();
    expect(row!.deliveredAt).toBeNull();
    expect(row!.deliveryAttempts).toBe(2);
  });

  it('signs the webhook payload with HMAC-SHA256 over the raw body', async () => {
    const { client, calls } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    await emitToParty(service);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const expected = createHmac('sha256', SECRET).update(call.body).digest('hex');
    expect(call.headers['x-recurrentpay-signature']).toBe(expected);
    expect(call.headers['x-recurrentpay-idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries a failing webhook with backoff and records the delivery attempts', async () => {
    const { client, attempts } = flakyTransport(2);
    const service = new NotificationService(notifications, endpoints, client, {
      maxAttempts: 5,
      baseDelayMs: 1,
      sleep: async () => undefined,
    });
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    await emitToParty(service);

    expect(attempts()).toBe(3);
    const row = await notifications.latest();
    expect(row!.deliveryAttempts).toBe(3);
    expect(row!.deliveredAt).not.toBeNull();
  });

  it('stops after maxAttempts when the transport never recovers', async () => {
    const { client, attempts } = flakyTransport(100);
    const service = new NotificationService(notifications, endpoints, client, {
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: async () => undefined,
    });
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    await emitToParty(service);

    expect(attempts()).toBe(3);
    const row = await notifications.latest();
    expect(row!.deliveredAt).toBeNull();
    expect(row!.deliveryAttempts).toBe(3);
  });

  it('dedupes by idempotency key (an event is persisted once)', async () => {
    const { client } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    const e = event();
    await emitToParty(service, e);
    await emitToParty(service, e); // same (subscription, type, at, data) → same key
    expect(await notifications.count()).toBe(1);
  });

  it('persists two distinct same-second events (payload discriminates the key)', async () => {
    const { client } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    // Same type, subscription and second, but a different payload (e.g. two
    // buffer warnings in one cycle) → distinct events, both persisted.
    await emitToParty(service, event({ data: { escrow: '10', requirement: '11' } }));
    await emitToParty(service, event({ data: { escrow: '9', requirement: '11' } }));

    expect(await notifications.count()).toBe(2);
  });

  it('dedupes a re-emitted event with the same payload (idempotent)', async () => {
    const { client } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({ url: 'https://example.test/hook', secret: SECRET, partyPkh: PARTY });

    const e = event({ data: { escrow: '10', requirement: '11' } });
    await emitToParty(service, e);
    await emitToParty(service, e);
    expect(await notifications.count()).toBe(1);
  });

  it('enforces the unique idempotency key at the DB level', async () => {
    // The repository checks first, but the unique index is the real guard: a
    // direct insert of a duplicate key must be rejected by the database.
    const repo = dataSource.getRepository(Notification);
    await repo.save(
      repo.create({
        subscriptionId: 'ff'.repeat(32),
        type: 'paused',
        payload: {},
        createdAt: 1,
        idempotencyKey: 'dup-key',
      }),
    );
    await expect(
      repo.save(
        repo.create({
          subscriptionId: 'ff'.repeat(32),
          type: 'paused',
          payload: {},
          createdAt: 2,
          idempotencyKey: 'dup-key',
        }),
      ),
    ).rejects.toThrow();
  });

  it('does not deliver to an inactive or other-party endpoint', async () => {
    const { client, calls } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);
    await endpoints.create({
      url: 'https://example.test/inactive',
      secret: SECRET,
      partyPkh: PARTY,
      active: false,
    });
    await endpoints.create({
      url: 'https://example.test/other',
      secret: SECRET,
      partyPkh: '99'.repeat(20),
    });

    // The event's parties are resolved from the subscription; with no subscription
    // row and no recipients passed, it should still not hit unrelated endpoints.
    await emitToParty(service);
    expect(calls).toHaveLength(0);
  });
});

describe('Notification event → recipients', () => {
  it('delivers to the endpoints of the supplied recipient pkhs', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Notification, WebhookEndpoint],
      synchronize: true,
    });
    await dataSource.initialize();
    const notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const endpoints = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
    const { client, calls } = recordingTransport();
    const service = new NotificationService(notifications, endpoints, client);

    await endpoints.create({ url: 'https://example.test/a', secret: SECRET, partyPkh: PARTY });
    await endpoints.create({ url: 'https://example.test/b', secret: SECRET, partyPkh: '22'.repeat(20) });

    await service.emit(
      { type: 'paused', subscriptionId: 'ff'.repeat(32), at: 1, data: {} },
      { recipients: [PARTY] },
    );
    expect(calls.map((c) => c.url)).toEqual(['https://example.test/a']);

    await dataSource.destroy();
  });
});
