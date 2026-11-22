/**
 * Notification service (Slice 4, spec § Notifications, § Postgres schema).
 *
 * Every event the scheduler (and, later, the API flows) emits is:
 *   1. **persisted** to the `notification` table first (the durable in-dapp log);
 *   2. delivered **in-dapp** simply by being in that log (the web app polls
 *      `/notifications`);
 *   3. delivered by **signed webhook** to each active `webhook_endpoint` of the
 *      recipient parties — HMAC-SHA256 over the raw body, at-least-once with
 *      retry/backoff, carrying a per-event idempotency key.
 *
 * A webhook failure never throws out of `emit`: the log row survives and the
 * delivery bookkeeping (`delivery_attempts`, `delivered_at`) records the outcome.
 *
 * The HTTP transport is injectable (`WEBHOOK_HTTP_CLIENT`), so tests mock it —
 * mirroring the oracle client.
 */
import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { NotificationEvent } from '../scheduler/scheduler.service.js';
import { NotificationRepository } from './notification.repository.js';
import { WebhookEndpointRepository } from './webhook-endpoint.repository.js';

/** DI token for the injectable webhook HTTP client (mocked in tests). */
export const WEBHOOK_HTTP_CLIENT = 'WEBHOOK_HTTP_CLIENT';

/** DI token for the delivery options (retry/backoff). */
export const WEBHOOK_DELIVERY_OPTIONS = 'WEBHOOK_DELIVERY_OPTIONS';

/** The minimal HTTP surface the client needs; `fetch` satisfies it. */
export interface WebhookHttpClient {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
  }>;
}

export interface DeliveryOptions {
  /** Maximum delivery attempts per endpoint (default 5). */
  maxAttempts: number;
  /** Base backoff delay in ms; doubles each retry (default 250). */
  baseDelayMs: number;
  /** Sleep function (tests inject a no-op). */
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DELIVERY: DeliveryOptions = {
  maxAttempts: 5,
  baseDelayMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Options for `emit`: who to notify (resolved by the caller). */
export interface EmitOptions {
  /**
   * The party pkhs to deliver to. Defaults to `[]` — **no** webhook targets
   * (in-dapp only). The caller resolves the subscription's parties and passes
   * them explicitly; the service does not look them up.
   */
  recipients?: string[];
  /** Unix seconds "now" (tests). Defaults to the event's `at`. */
  now?: number;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly endpoints: WebhookEndpointRepository,
    @Inject(WEBHOOK_HTTP_CLIENT) private readonly http: WebhookHttpClient,
    @Optional() @Inject(WEBHOOK_DELIVERY_OPTIONS) delivery?: Partial<DeliveryOptions>,
  ) {
    this.delivery = { ...DEFAULT_DELIVERY, ...delivery };
  }

  private readonly delivery: DeliveryOptions;

  /**
   * Persist an event (idempotently) and deliver it by webhook.
   *
   * The persistence step always runs first and is the only hard requirement: a
   * duplicate event returns the existing row and is not re-delivered (the caller
   * can rely on at-least-once delivery from the first emit). Never throws.
   */
  async emit(event: NotificationEvent, options: EmitOptions = {}): Promise<void> {
    const key = idempotencyKey(event);
    let row;
    try {
      const result = await this.notifications.insert({
        subscriptionId: event.subscriptionId,
        type: event.type,
        // BigInt fields (periods settled, gross, fee) must be stringified before
        // JSON persistence — `JSON.stringify` throws on a BigInt.
        payload: jsonSafe(event.data ?? {}),
        createdAt: event.at,
        idempotencyKey: key,
      });
      row = result.row;
      if (!result.created) {
        // Already logged (and, on the first emit, delivery was attempted).
        return;
      }
    } catch (error) {
      this.logger.warn(`notification persist failed for ${key}: ${(error as Error).message}`);
      return;
    }

    try {
      await this.deliver(row.id, event, options);
    } catch (error) {
      // Delivery is best-effort; the log row is already durable.
      this.logger.warn(`notification delivery failed for ${key}: ${(error as Error).message}`);
    }
  }

  /** Deliver to every active endpoint of the recipient parties. */
  private async deliver(
    id: number,
    event: NotificationEvent,
    options: EmitOptions,
  ): Promise<void> {
    const recipients = options.recipients ?? [];
    const targets = await this.endpoints.findActiveByParties(recipients);
    if (targets.length === 0) {
      // In-dapp only: the row is the delivery. Mark it delivered so the log is
      // honest about there being no webhook attempt pending.
      await this.notifications.recordDelivery(id, 0, options.now ?? event.at);
      return;
    }

    const body = JSON.stringify({
      id: idempotencyKey(event),
      type: event.type,
      subscriptionId: event.subscriptionId,
      at: event.at,
      data: jsonSafe(event.data ?? {}),
    });

    let attempts = 0;
    let deliveredAt: number | null = null;
    for (const target of targets) {
      const result = await this.deliverTo(target.url, target.secret, body, event);
      attempts += result.attempts;
      if (result.delivered) deliveredAt = options.now ?? event.at;
    }
    await this.notifications.recordDelivery(id, attempts, deliveredAt);
  }

  /** Deliver one webhook with retry/backoff; returns the attempts and outcome. */
  private async deliverTo(
    url: string,
    secret: string,
    body: string,
    event: NotificationEvent,
  ): Promise<{ attempts: number; delivered: boolean }> {
    const signature = signPayload(secret, body);
    const headers = {
      'content-type': 'application/json',
      'x-recurrentpay-signature': signature,
      'x-recurrentpay-idempotency-key': idempotencyKey(event),
    };

    for (let attempt = 1; attempt <= this.delivery.maxAttempts; attempt += 1) {
      try {
        const response = await this.http(url, { method: 'POST', headers, body });
        if (response.ok) return { attempts: attempt, delivered: true };
      } catch (error) {
        this.logger.warn(`webhook ${url} attempt ${attempt} threw: ${(error as Error).message}`);
      }
      if (attempt < this.delivery.maxAttempts) {
        await this.delivery.sleep(this.delivery.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    return { attempts: this.delivery.maxAttempts, delivered: false };
  }
}

/** HMAC-SHA256 of the raw body, hex — the `X-RecurrentPay-Signature` value. */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Convert a payload to JSON-safe values: `bigint → string` (token amounts are
 * bigints, and `JSON.stringify` throws on them). Recursive, so a nested bigint
 * (`data: { receipt: { gross: 10n } }`) is also stringified rather than throwing
 * at the `JSON.stringify` boundary.
 */
export function jsonSafe(data: Record<string, unknown>): Record<string, unknown> {
  return safeValue(data) as Record<string, unknown>;
}

/** Recursively stringify bigints; arrays and plain objects are rebuilt. */
function safeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(safeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = safeValue(inner);
    return out;
  }
  return value;
}

/**
 * The per-event idempotency key: `sha256(type ‖ subscriptionId ‖ at ‖ payload)`.
 *
 * Two emits of the *same* event (same type, sub, timestamp and payload) share a
 * key and dedupe. Including the payload digest means two genuinely distinct
 * events that land in the same second (e.g. two buffer warnings in one cycle)
 * get distinct keys and are both persisted — the `at`-only key collapsed them.
 */
export function idempotencyKey(event: NotificationEvent): string {
  const payload = JSON.stringify(jsonSafe(event.data ?? {}));
  return createHmac('sha256', 'recurrentpay-notification')
    .update(`${event.type}|${event.subscriptionId}|${event.at}|${payload}`)
    .digest('hex');
}
