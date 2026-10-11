import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reaching a human: a Twilio voice call the caregiver can answer with a key
 * press, a text message, and the existing chat webhook. Without Twilio
 * credentials every action is logged as a dry run so the demo still shows
 * exactly what would happen.
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM   your Twilio number
 *   CAREGIVER_PHONE        +1..., several separated by commas
 *   PUBLIC_URL             the https tunnel address (lets the caregiver press 1 or 2)
 *   ECHOSENSE_WEBHOOK      Discord or Slack webhook (optional)
 */

export interface NotifyConfig {
  sid: string;
  token: string;
  from: string;
  to: string[];
  publicUrl: string;
  webhook: string;
  sms: boolean;
  webexToken: string;
  webexRoomId: string;
  webexToEmail: string;
}

export function notifyFromEnv(env: NodeJS.ProcessEnv = process.env, webhook = ''): NotifyConfig {
  return {
    sid: env.TWILIO_ACCOUNT_SID ?? '',
    token: env.TWILIO_AUTH_TOKEN ?? '',
    from: env.TWILIO_FROM ?? '',
    to: (env.CAREGIVER_PHONE ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    webhook: webhook || env.ECHOSENSE_WEBHOOK || '',
    sms: env.ECHOSENSE_SMS !== '0',
    webexToken: env.WEBEX_BOT_TOKEN ?? '',
    webexRoomId: env.WEBEX_ROOM_ID ?? '',
    webexToEmail: env.WEBEX_TO_EMAIL ?? '',
  };
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export class Notifier {
  constructor(public cfg: NotifyConfig) {}

  get twilioReady(): boolean {
    return !!(this.cfg.sid && this.cfg.token && this.cfg.from && this.cfg.to.length);
  }

  describe(): string {
    const tw = this.twilioReady
      ? `Calls and texts go to ${this.cfg.to.map(mask).join(', ')}${this.cfg.publicUrl ? ', caregiver can press 1 or 2' : ''}`
      : 'Twilio not configured: calls and texts are dry runs';
    const wx = this.webexReady ? `Webex alerts to ${this.cfg.webexRoomId ? 'your space' : this.cfg.webexToEmail}` : 'Webex not set up';
    return `${tw}. ${wx}`;
  }

  private async twilio(path: string, form: Record<string, string>): Promise<SendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.sid}/${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${this.cfg.sid}:${this.cfg.token}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) return { ok: false, detail: `Twilio ${res.status}: ${body.message ?? 'error'}${body.code ? ` (code ${body.code})` : ''}` };
    return { ok: true, detail: body.sid ?? 'sent' };
  }

  async call(incidentId: string, spoken: string): Promise<SendResult> {
    if (!this.twilioReady) return { ok: true, detail: `dry run: would call the caregiver and say "${spoken}"` };
    const gather = this.cfg.publicUrl
      ? `<Gather numDigits="1" timeout="10" method="POST" action="${xml(`${this.cfg.publicUrl}/twilio/gather?incident=${encodeURIComponent(incidentId)}`)}">` +
        `<Say voice="Polly.Joanna">Press 1 if you are on your way. Press 2 if they are OK and this is a false alarm.</Say></Gather>` +
        `<Say voice="Polly.Joanna">No key pressed. EchoSense will keep alerting.</Say>`
      : `<Pause length="1"/><Say voice="Polly.Joanna">${xml(spoken)}</Say>`;
    const twiml = `<Response><Say voice="Polly.Joanna">${xml(spoken)}</Say>${gather}</Response>`;
    const results = await Promise.all(this.cfg.to.map((to) => this.twilio('Calls.json', { To: to, From: this.cfg.from, Twiml: twiml })));
    return { ok: results.some((r) => r.ok), detail: results.map((r, i) => `${mask(this.cfg.to[i])}: ${r.ok ? 'calling' : r.detail}`).join('; ') };
  }

  async sms(text: string): Promise<SendResult> {
    if (!this.cfg.sms) return { ok: true, detail: 'texts turned off' };
    if (!this.twilioReady) return { ok: true, detail: `dry run: would text "${text}"` };
    const results = await Promise.all(this.cfg.to.map((to) => this.twilio('Messages.json', { To: to, From: this.cfg.from, Body: text })));
    return { ok: results.some((r) => r.ok), detail: results.map((r, i) => `${mask(this.cfg.to[i])}: ${r.ok ? 'sent' : r.detail}`).join('; ') };
  }

  async webhook(text: string): Promise<SendResult> {
    if (!this.cfg.webhook) return { ok: true, detail: 'no webhook set' };
    try {
      const res = await fetch(this.cfg.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, text }),
      });
      return { ok: res.ok, detail: res.ok ? 'posted' : `webhook ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------- Cisco Webex
  get webexReady(): boolean {
    return !!(this.cfg.webexToken && (this.cfg.webexRoomId || this.cfg.webexToEmail));
  }

  private async webexApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
    const res = await fetch(`https://webexapis.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.webexToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  private target(): Record<string, string> {
    return this.cfg.webexRoomId ? { roomId: this.cfg.webexRoomId } : { toPersonEmail: this.cfg.webexToEmail };
  }

  /** Posts the alert to Webex as a card the caregiver can answer with one tap. */
  async webex(incidentId: string, title: string, text: string, facts: { title: string; value: string }[], buttons: boolean): Promise<SendResult> {
    if (!this.cfg.webexToken) return { ok: true, detail: 'Webex not set up' };
    if (!this.webexReady) return { ok: false, detail: 'set WEBEX_ROOM_ID or WEBEX_TO_EMAIL' };
    const card = {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.2',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color: buttons ? 'Attention' : 'Default', wrap: true },
          { type: 'TextBlock', text, wrap: true },
          ...(facts.length ? [{ type: 'FactSet', facts }] : []),
        ],
        actions: buttons
          ? [
              { type: 'Action.Submit', title: 'On my way', data: { incident: incidentId, answer: 'on_my_way' } },
              { type: 'Action.Submit', title: 'They are OK', data: { incident: incidentId, answer: 'false_alarm' } },
            ]
          : [],
      },
    };
    try {
      const markdown = `**${title}**\n\n${text}${facts.length ? `\n\n${facts.map((f) => `- **${f.title}:** ${f.value}`).join('\n')}` : ''}`.slice(0, 7000);
      const r = await this.webexApi('POST', 'messages', { ...this.target(), markdown, attachments: [card] });
      if (r.ok) return { ok: true, detail: `posted to Webex${buttons && !this.cfg.publicUrl ? ' (set PUBLIC_URL to make the buttons work)' : ''}` };
      // The card was refused: still get the words through as a plain message.
      const why = `${r.status}: ${r.json?.message ?? 'error'}`;
      console.warn(`[witness] Webex card refused (${why}), sending plain text`);
      const plain = await this.webexApi('POST', 'messages', { ...this.target(), markdown });
      return plain.ok ? { ok: true, detail: `posted to Webex as text (the card was refused: ${why})` } : { ok: false, detail: `Webex ${plain.status}: ${plain.json?.message ?? 'error'} (card: ${why})` };
    } catch (e) {
      return { ok: false, detail: `Webex: ${(e as Error).message}` };
    }
  }

  async webexText(markdown: string): Promise<void> {
    if (!this.webexReady) return;
    const r = await this.webexApi('POST', 'messages', { ...this.target(), markdown }).catch((e: Error) => ({ ok: false, status: 0, json: { message: e.message } }));
    if (!r.ok) console.warn(`[witness] Webex message failed: ${r.status} ${r.json?.message ?? ''}`);
  }

  /** Registers (or refreshes) the webhook that tells the hub when a card button is pressed. */
  async registerWebex(secret: string): Promise<string> {
    if (!this.webexReady) return this.cfg.webexToken ? 'Webex: set WEBEX_ROOM_ID or WEBEX_TO_EMAIL' : 'Webex not set up';
    if (!this.cfg.publicUrl) return 'Webex alerts on (set PUBLIC_URL for the card buttons)';
    try {
      const target = `${this.cfg.publicUrl}/webex/actions`;
      const list = await this.webexApi('GET', 'webhooks');
      for (const h of (list.json?.items ?? []) as { id: string; name: string }[]) {
        if (h.name === 'echosense-witness') await this.webexApi('DELETE', `webhooks/${h.id}`);
      }
      const r = await this.webexApi('POST', 'webhooks', { name: 'echosense-witness', targetUrl: target, resource: 'attachmentActions', event: 'created', secret });
      return r.ok ? 'Webex alerts and card buttons on' : `Webex webhook failed: ${r.json?.message ?? r.status}`;
    } catch (e) {
      return `Webex webhook failed: ${(e as Error).message}`;
    }
  }

  /** Reads which button was pressed (Webex sends only the action id). */
  async webexAction(actionId: string): Promise<{ incident: string; answer: string; person: string } | null> {
    const r = await this.webexApi('GET', `attachment/actions/${encodeURIComponent(actionId)}`);
    if (!r.ok) return null;
    const inputs = (r.json?.inputs ?? {}) as { incident?: string; answer?: string };
    if (!inputs.incident || !inputs.answer) return null;
    let person = 'caregiver';
    const who = await this.webexApi('GET', `people/${encodeURIComponent(r.json.personId)}`).catch(() => null);
    if (who?.ok && who.json?.displayName) person = who.json.displayName;
    return { incident: inputs.incident, answer: inputs.answer, person };
  }

  /** Webex signs webhook bodies with HMAC SHA1 (hex) of the raw body. */
  static verifyWebex(raw: string, secret: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expect = createHmac('sha1', secret).update(raw).digest('hex');
    return expect.length === signature.length && timingSafeEqual(Buffer.from(expect), Buffer.from(signature));
  }

  /** Validates Twilio's request signature on the key press callback. */
  verify(fullUrl: string, params: Record<string, string>, signature: string | undefined): boolean {
    if (!this.cfg.token) return false;
    if (!signature) return false;
    const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expect = createHmac('sha1', this.cfg.token).update(data).digest();
    const got = Buffer.from(signature, 'base64');
    return got.length === expect.length && timingSafeEqual(got, expect);
  }
}

export function mask(n: string): string {
  return n.length > 4 ? `${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : n;
}

export function gatherReply(digit: string): string {
  const say =
    digit === '1'
      ? 'Thank you. We will tell them help is on the way.'
      : digit === '2'
        ? 'Thank you. EchoSense will stand down.'
        : 'Sorry, that key is not recognised. EchoSense will keep alerting.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${say}</Say></Response>`;
}
