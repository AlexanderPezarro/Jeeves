import { readFileSync } from "node:fs";
import type { Db, MessageRow } from "./db.js";

/** Delivers an outgoing message to the phone. Messages are always stored first, so the app can also poll. */
export interface Notifier {
  notify(message: MessageRow): Promise<void>;
}

/** Used when Firebase is not configured: the app picks messages up by polling GET /messages. */
export class PollOnlyNotifier implements Notifier {
  async notify(): Promise<void> {}
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
        items: JSON.stringify(message.items ?? []),
      },
    });
    res.responses.forEach((r, i) => {
      if (!r.success) console.warn(`FCM send to device ${i} failed: ${r.error?.message}`);
    });
  }
}

export function makeNotifier(db: Db, env: NodeJS.ProcessEnv = process.env): Notifier {
  const path = env.FIREBASE_SERVICE_ACCOUNT;
  if (!path) {
    console.log("FIREBASE_SERVICE_ACCOUNT not set: push is off, the app will poll for messages");
    return new PollOnlyNotifier();
  }
  return new FcmNotifier(db, path);
}
