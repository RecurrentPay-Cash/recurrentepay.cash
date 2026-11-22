/**
 * Webhook endpoint registration (Slice 4 review MINOR 3, spec § Notifications —
 * outbound webhook).
 *
 * Without a registration route the webhook delivery path is unreachable: the
 * transport exists but no `webhook_endpoint` row is ever created. These routes
 * are authenticated and scoped to the caller's pkh — a party can only register
 * (and list) its own endpoints.
 *
 * The HMAC `secret` is stored **plaintext at rest** for the MVP (the receiver
 * verifies `X-RecurrentPay-Signature` with it). Encrypting at rest is post-MVP;
 * see the README note.
 */
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { WebhookEndpointRepository } from '../notifications/webhook-endpoint.repository.js';

/** The API view of a registered endpoint — the secret is never returned. */
export interface WebhookEndpointView {
  id: number;
  url: string;
  partyPkh: string;
  active: boolean;
}

@Controller('webhooks')
@UseGuards(AuthGuard)
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointRepository,
    private readonly guard: AuthGuard,
  ) {}

  /** The caller's registered endpoints (the secret is never echoed). */
  @Get()
  async list(@Req() request: AuthedRequest): Promise<WebhookEndpointView[]> {
    const pkh = this.guard.caller(request);
    const rows = await this.endpoints.findByParty(pkh);
    return rows.map(toView);
  }

  /**
   * Register an endpoint for the caller. `secret` is optional — when omitted the
   * server generates one and returns it **once** (it is not retrievable later).
   */
  @Post()
  async register(
    @Req() request: AuthedRequest,
    @Body() body: { url?: string; secret?: string },
  ): Promise<WebhookEndpointView & { secret: string }> {
    const pkh = this.guard.caller(request);
    const url = body?.url;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new BadRequestException('url is required');
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('url must be an http(s) URL');
    }
    const secret =
      typeof body?.secret === 'string' && body.secret !== '' ? body.secret : randomSecret();
    const row = await this.endpoints.create({ url, secret, partyPkh: pkh });
    return { ...toView(row), secret };
  }
}

/** A 32-byte random HMAC secret (hex). */
function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

function toView(row: { id: number; url: string; partyPkh: string; active: boolean }): WebhookEndpointView {
  return { id: row.id, url: row.url, partyPkh: row.partyPkh, active: row.active };
}
