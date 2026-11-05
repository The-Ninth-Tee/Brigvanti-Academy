// Brigvanti coach proxy. The browser sends a Firebase ID token, and this file
// verifies it. All capping and the call to Anthropic live in coach-gate.mjs.
// Do not call Anthropic from here. tool/check-coach-cap.mjs blocks such a deploy.

import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/firebase-admin.mjs";
import { createCoachHandler, firestoreUsageStore } from "../lib/coach-gate.mjs";

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

export default createCoachHandler({
  verify: verifyIdToken,
  store: firestoreUsageStore(db, FieldValue.increment)
});
