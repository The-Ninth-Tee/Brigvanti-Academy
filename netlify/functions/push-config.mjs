/* Hands the public push key to the app. The private key never leaves the server. */
export default async () =>
  Response.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' }, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
