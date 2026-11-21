/**
 * Spec: subscription-contract/spec.md — "pkh self-service transfer (1 signature)".
 *
 * Covers task 4.14 (transfers: all three roles, cross-role rejection, offline gift).
 */
import { MODE_B, scenario, type Scenario } from './helpers/harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    escrow: 101n,
    creationTime: T,
    ...over,
  });

describe('pkh self-service transfer', () => {
  it('the supporter transfers the subscription to a new address', async () => {
    const sub = base();
    const newSupporter = Uint8Array.from(new Array(20).fill(0xab));
    await sub.setPkh({ supporter: newSupporter }, sub.supporter).send();
    expect((await sub.readCovenant()).state?.supporterPkh).toEqual(newSupporter);
  });

  it('the supportee transfers their own pkh', async () => {
    const sub = base();
    const newSupportee = Uint8Array.from(new Array(20).fill(0xcd));
    await sub.setPkh({ supportee: newSupportee }, sub.supportee).send();
    expect((await sub.readCovenant()).state?.supporteePkh).toEqual(newSupportee);
  });

  it('the service transfers its own pkh', async () => {
    const sub = base();
    const newService = Uint8Array.from(new Array(20).fill(0xef));
    await sub.setPkh({ service: newService }, sub.service).send();
    expect((await sub.readCovenant()).state?.servicePkh).toEqual(newService);
  });

  it('cross-role modification is rejected (supporter cannot move the supportee)', async () => {
    const sub = base();
    const forged = Uint8Array.from(new Array(20).fill(0xee));
    // Supporter present, but the patch changes the supportee's pkh.
    const { message } = await requireError(sub.setPkh({ supportee: forged }, sub.supporter));
    expect(message).toMatch(/setPkh: supportee presence required/);
  });

  it('an offline gift needs no action from the recipient', async () => {
    const sub = base();
    const recipient = Uint8Array.from(new Array(20).fill(0x42));
    // The current supporter moves the sub to a wallet that never touched the app.
    await sub.setPkh({ supporter: recipient }, sub.supporter).send();
    expect((await sub.readCovenant()).state?.supporterPkh).toEqual(recipient);
  });

  it('does not move the clock (no settle)', async () => {
    const sub = base();
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    const newSupporter = Uint8Array.from(new Array(20).fill(0xab));
    await sub.setPkh({ supporter: newSupporter }, sub.supporter).send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(before);
  });
});
