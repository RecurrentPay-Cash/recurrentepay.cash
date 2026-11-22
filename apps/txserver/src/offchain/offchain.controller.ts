/**
 * Off-chain platform REST API (Slice 6, spec § Off-chain channel and plan
 * management, § API for web app).
 *
 * Authenticated CRUD for a creator's channel (one per creator for MVP) and its
 * plans, plus the plan data API the create wizard reads. Plans are soft-deleted
 * (hidden) — never hard-deleted. Everything here is metadata; the chain remains
 * the source of truth for a sub's terms and status.
 *
 * Ownership: the authenticated caller pkh resolves to a creator account; a
 * caller can only read/edit their own channel and plans (another creator's plan
 * is a 403).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import {
  OffchainService,
  type ChannelView,
  type PlanView,
} from './offchain.service.js';
import type { ChannelUpsert } from './channel.repository.js';
import type { PlanUpsert } from './plan.repository.js';
import { parseId } from '../api/query-id.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';

@Controller('offchain')
export class OffchainController {
  constructor(
    private readonly offchain: OffchainService,
    private readonly guard: AuthGuard,
    private readonly subscriptions: SubscriptionRepository,
  ) {}

  /**
   * The plan data API: visible plans for the wizard. **Public** — it exposes
   * only discovery metadata (never a party's subscriptions), so it is the one
   * unauthenticated route on this controller.
   *
   * A **present but invalid** `channelId` (`?channelId=abc`, `-1`, `1e3`) fails
   * closed to `[]` rather than widening to the whole discovery feed (Slice 6
   * review Minor 3) — consistent with the subscription filter's fail-closed
   * stance.
   */
  @Get('plan-data')
  async planData(@Query('channelId') channelId?: string): Promise<PlanView[]> {
    if (channelId === undefined) return this.offchain.visiblePlans();
    const parsed = parseId(channelId);
    if (parsed === undefined) return [];
    return this.offchain.visiblePlans(parsed);
  }

  /** The caller's channel (with its visible plans), or `null`. */
  @Get('channel')
  @UseGuards(AuthGuard)
  async myChannel(@Req() request: AuthedRequest): Promise<ChannelView | null> {
    return this.offchain.myChannel(this.guard.caller(request));
  }

  /** Create the caller's channel (one per creator for MVP). */
  @Post('channel')
  @UseGuards(AuthGuard)
  async createChannel(
    @Req() request: AuthedRequest,
    @Body() body: Partial<ChannelUpsert>,
  ): Promise<ChannelView> {
    return this.offchain.createChannel(this.guard.caller(request), body);
  }

  /** Edit the caller's channel. */
  @Put('channel')
  @UseGuards(AuthGuard)
  async updateChannel(
    @Req() request: AuthedRequest,
    @Body() body: Partial<ChannelUpsert>,
  ): Promise<ChannelView> {
    return this.offchain.updateChannel(this.guard.caller(request), body);
  }

  /** The caller's plans (visible only) — seeds the create wizard. */
  @Get('plans')
  @UseGuards(AuthGuard)
  async myPlans(@Req() request: AuthedRequest): Promise<PlanView[]> {
    return this.offchain.myPlans(this.guard.caller(request));
  }

  /** Add a plan to the caller's channel. */
  @Post('plans')
  @UseGuards(AuthGuard)
  async createPlan(
    @Req() request: AuthedRequest,
    @Body() body: Partial<PlanUpsert>,
  ): Promise<PlanView> {
    return this.offchain.createPlan(this.guard.caller(request), body);
  }

  /** Edit a plan on the caller's channel. */
  @Put('plans/:id')
  @UseGuards(AuthGuard)
  async updatePlan(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<PlanUpsert>,
  ): Promise<PlanView> {
    return this.offchain.updatePlan(this.guard.caller(request), id, body);
  }

  /**
   * Soft-delete (hide) a plan. The plan leaves discovery; linked subscriptions
   * stay valid. There is deliberately no hard-delete route.
   */
  @Delete('plans/:id')
  @UseGuards(AuthGuard)
  async hidePlan(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PlanView> {
    return this.offchain.hidePlan(this.guard.caller(request), id);
  }

  /**
   * Persist the plan → subscription link for a subscription the caller is a
   * party to (spec § Off-chain channel and plan management — "the txserver
   * writes a subscription-link row on creation"). The caller must be a party to
   * the subscription; the plan must be on the caller's own channel (a creator
   * may only link their own plans — another creator's plan is a 403).
   *
   * This is the production path for the link write: the web app calls it after a
   * creation it built carries a `planId`. It is metadata only — it never alters
   * the sub's on-chain terms.
   */
  @Post('subscriptions/:subscriptionId/link')
  @UseGuards(AuthGuard)
  async linkSubscription(
    @Req() request: AuthedRequest,
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { planId?: number | string },
  ) {
    const planId = parseId(String(body?.planId ?? ''));
    if (planId === undefined) throw new BadRequestException('planId is required');
    return this.offchain.linkForCaller({
      callerPkh: this.guard.caller(request),
      subscriptionId,
      planId,
      partyOf: async (id, pkh) =>
        (await this.subscriptions.findByIdForParty(id, pkh)) !== null,
    });
  }
}
