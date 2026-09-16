// Brigvanti coach proxy.
// The browser calls /.netlify/functions/coach. This function adds the secret
// API key server-side and forwards the request to Anthropic. The key is never
// sent to the browser. Set ANTHROPIC_API_KEY in Netlify, Environment variables.
//
// The endpoint is gated. Only a signed in learner can reach Anthropic, so the
// endpoint cannot be abused to spend API credits. The browser sends a Firebase
// ID token as "Authorization: Bearer <token>". This function verifies it
// against Google's public keys before forwarding.
//
// Optional: set COACH_MODEL to change the model without editing code.

import crypto from "node:crypto";

const PROJECT_ID = "brigvanti-academy";
const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// Google rotates its signing certificates. Cache them until the max-age given
// in the response, so most requests verify without a network call.
let certCache = { until: 0, keys: null };
async function googleCerts() {
  const now = Date.now();
  if (certCache.keys && now < certCache.until) return certCache.keys;
  const res = await fetch(CERT_URL);
  const keys = await res.json();
  const cc = res.headers.get("cache-control") || "";
  const m = /max-age=(\d+)/.exec(cc);
  certCache = { until: now + (m ? parseInt(m[1], 10) * 1000 : 3600 * 1000), keys };
  return keys;
}

function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// Verify a Firebase ID token. Throws on any failure.
async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
  const payload = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  if (header.alg !== "RS256") throw new Error("alg");

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error("kid");

  const pub = crypto.createPublicKey(pem);
  const signed = Buffer.from(parts[0] + "." + parts[1]);
  if (!crypto.verify("RSA-SHA256", signed, pub, fromB64url(parts[2]))) {
    throw new Error("sig");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("expired");
  if (payload.iat > now + 300) throw new Error("future");
  if (payload.aud !== PROJECT_ID) throw new Error("aud");
  if (payload.iss !== "https://securetoken.google.com/" + PROJECT_ID) throw new Error("iss");
  if (!payload.sub) throw new Error("sub");
  return payload;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Gate: require a valid Firebase ID token.
  const authz = req.headers.get("authorization") || "";
  const m = /^Bearer (.+)$/.exec(authz);
  if (!m) {
    return json({ error: "Please sign in to use the coach." }, 401);
  }
  try {
    await verifyIdToken(m[1]);
  } catch (e) {
    return json({ error: "Please sign in to use the coach." }, 401);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Bad request." }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Bad request." }, 400);
  }

  // Force a known-good model and cap the size, so the endpoint cannot be
  // steered into an expensive request.
  body.model = process.env.COACH_MODEL || "claude-sonnet-5";
  body.max_tokens = Math.min(Number(body.max_tokens) || 1000, 1500);

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return json({ error: "Upstream request failed." }, 502);
  }

  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json" }
  });
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
