import { readFileSync } from "node:fs";
import * as webpush from "web-push";
import type { Db, MessageRow } from "./db.js";

/** Delivers an outgoing message to the phone. Messages are always stored first, so the app can also poll. */
export interface Notifier {
  notify(message: MessageRow): Promise<void>;
}

/** Used when Firebase is not configured: the app picks messages up by polling GET /messages. */
export class PollOnlyNotifier implements Notifier {
  async notify(): Promise<void> {}
}

/** The data every push carries, shared by FCM and Web Push so new fields are added in one place. */
export function pushPayload(message: MessageRow): {
  message_id: number;
  text: string;
  items: NonNullable<MessageRow["items"]>;
  level?: string;
  due_at?: string;
} {
  return {
    message_id: message.id,
    text: message.text,
    items: message.items ?? [],
    ...(message.level ? { level: message.level } : {}),
    ...(message.due_at ? { due_at: message.due_at } : {}),
  };
}

/**
 * Sends a data-only FCM message so the Android app builds the notification itself,
 * with Done / Snooze / Skip buttons for each task.
 */
export class FcmNotifier implements Notifier {
  private messaging?: import("firebase-admin/messaging").Messaging;

  constructor(
    private readonly db: Db,
    private readonly serviceAccountPath: string,
  ) {}

  private async init() {
    if (this.messaging) return this.messaging;
    const { initializeApp, cert } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");
    const app = initializeApp({ credential: cert(JSON.parse(readFileSync(this.serviceAccountPath, "utf8"))) });
    this.messaging = getMessaging(app);
    return this.messaging;
  }

  async notify(message: MessageRow): Promise<void> {
    const tokens = this.db.pushTokens();
    if (tokens.length === 0) return;
    const messaging = await this.init();
    const res = await messaging.sendEachForMulticast({
      tokens,
      android: { priority: "high" },
      data: {
        message_id: String(message.id),
        text: message.text,
        items: JSON.stringify(pushPayload(message).items),
        ...(message.level ? { level: message.level } : {}),
        ...(message.due_at ? { due_at: message.due_at } : {}),
      },
    });
    res.responses.forEach((r, i) => {
      if (!r.success) console.warn(`FCM send to device ${i} failed: ${r.error?.message}`);
    });
  }
}

export interface VapidDetails {
  publicKey: string;
  privateKey: string;
  subject: string;
}

type SendNotification = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { TTL: number; urgency: "high"; vapidDetails: { subject: string; publicKey: string; privateKey: string } },
) => Promise<unknown>;

/** ntfy and UnifiedPush cap a message at about 4 KB; stay well under it once encrypted. */
const MAX_PLAINTEXT_BYTES = 3000;
const TTL_SECONDS = 12 * 60 * 60;

/**
 * Sends Web Push (RFC 8030, aes128gcm per RFC 8291, VAPID per RFC 8292) to every device that has
 * registered an endpoint. With UnifiedPush the endpoint is on the self-hosted ntfy server.
 */
export class WebPushNotifier implements Notifier {
  /**
   * @param endpointRewrite `from=to`: endpoints starting with `from` are posted to `to` instead. Lets the
   *   server reach ntfy over the Docker network when the public name only resolves to a Tailscale IP.
   */
  constructor(
    private readonly db: Db,
    private readonly vapid: VapidDetails,
    private readonly send: SendNotification = webpush.sendNotification as unknown as SendNotification,
    private readonly endpointRewrite?: string,
  ) {}

  private target(endpoint: string): string {
    const eq = this.endpointRewrite?.indexOf("=") ?? -1;
    if (!this.endpointRewrite || eq < 1) return endpoint;
    const from = this.endpointRewrite.slice(0, eq);
    const to = this.endpointRewrite.slice(eq + 1);
    return endpoint.startsWith(from) ? to + endpoint.slice(from.length) : endpoint;
  }

  async notify(message: MessageRow): Promise<void> {
    const subs = this.db.webPushSubscriptions();
    if (subs.length === 0) return;
    let body = JSON.stringify(pushPayload(message));
    if (Buffer.byteLength(body) > MAX_PLAINTEXT_BYTES) body = JSON.stringify({
        message_id: message.id,
        truncated: true,
        ...(message.level ? { level: message.level } : {}),
        ...(message.due_at ? { due_at: message.due_at } : {}),
      });
    const vapidDetails = { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey };
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await this.send(
            { endpoint: this.target(sub.endpoint), keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: TTL_SECONDS, urgency: "high", vapidDetails },
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            console.warn(`Web push endpoint gone (${status}), removing it`);
            this.db.clearWebPushByEndpoint(sub.endpoint);
          } else {
            console.warn(`Web push to device ${sub.device_id} failed: ${(e as Error).message}`);
          }
        }
      }),
    );
  }
}

export function makeNotifier(db: Db, env: NodeJS.ProcessEnv = process.env): Notifier {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    console.log("Push: Web Push (UnifiedPush) is on");
    return new WebPushNotifier(
      db,
      {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT || "mailto:jeeves@localhost",
      },
      undefined,
      env.PUSH_ENDPOINT_REWRITE || undefined,
    );
  }
  const path = env.FIREBASE_SERVICE_ACCOUNT;
  if (!path) {
    console.log("VAPID_* and FIREBASE_SERVICE_ACCOUNT not set: push is off, the app will poll for messages");
    return new PollOnlyNotifier();
  }
  console.log("Push: FCM is on");
  return new FcmNotifier(db, path);
}
