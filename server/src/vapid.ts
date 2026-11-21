import * as webpush from "web-push";

/** Generates a VAPID key pair as `.env` lines. */
export function generateVapidKeys(): string {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return [
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    "VAPID_SUBJECT=mailto:you@example.com",
  ].join("\n");
}

export function printVapidKeys(): void {
  console.log(generateVapidKeys());
}
