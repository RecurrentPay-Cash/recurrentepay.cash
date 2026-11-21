/**
 * Spec: subscription-contract/spec.md — "pkh self-service transfer (1 signature)".
 *
 * Covers task 3.3. Exactly one role moves per call, authorised by its holder.
 */
import { MODE_B, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    ...over,
  });

describe('pkh self-service transfer', () => {
  it('the supporter transfers the subscription to a new address', async () => {
    const sub = base();
    const next = Uint8Array.from(new Array(20).fill(0xab));
    await sub.setPkh({ supporter: next }, sub.supporter).send();
    expect((await sub.readCovenant()).state?.supporterPkh).toEqual(next);
  });

  it('the supportee transfers their own pkh', async () => {
    const sub = base();
    const next = Uint8Array.from(new Array(20).fill(0xcd));
    await sub.setPkh({ supportee: next }, sub.supportee).send();
    expect((await sub.readCovenant()).state?.supporteePkh).toEqual(next);
  });

  it('the service transfers its own pkh', async () => {
    const sub = base();
    const next = Uint8Array.from(new Array(20).fill(0xef));
    await sub.setPkh({ service: next }, sub.service).send();
    expect((await sub.readCovenant()).state?.servicePkh).toEqual(next);
  });

  it('cross-role modification is rejected', async () => {
    const sub = base();
    const forged = Uint8Array.from(new Array(20).fill(0xee));
    const { message } = await requireError(sub.setPkh({ supportee: forged }, sub.supporter));
    expect(message).toMatch(/setPkh: supportee presence required/);
  });

  it('does not move the clock', async () => {
    const sub = base();
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    await sub.setPkh({ supporter: Uint8Array.from(new Array(20).fill(0xab)) }, sub.supporter).send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(before);
  });
});
