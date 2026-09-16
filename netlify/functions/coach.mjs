// Brigvanti coach proxy.
// The browser calls /.netlify/functions/coach. This function adds the secret
// API key server-side and forwards the request to Anthropic. The key is never
// sent to the browser. Set ANTHROPIC_API_KEY in Netlify, Environment variables.
//
// Optional: set COACH_MODEL to change the model without editing code.

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
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
