const REDIRECT_VERSION = "v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return renderLandingPage(url.origin);
    }

    if (url.pathname !== "/open") {
      return renderError(404, "Not found");
    }

    const secret = String(env.REDIRECT_SIGNING_SECRET || "").trim();
    if (!secret) {
      return renderError(500, "Missing REDIRECT_SIGNING_SECRET");
    }

    const encodedDestination = url.searchParams.get("u") || "";
    const nonce = url.searchParams.get("n") || "";
    const signature = url.searchParams.get("s") || "";
    const version = url.searchParams.get("v") || "";

    if (!encodedDestination || !nonce || !signature || version !== REDIRECT_VERSION) {
      return renderError(400, "Missing or invalid redirect parameters");
    }

    const isValidSignature = await verifySignature(secret, encodedDestination, nonce, signature);
    if (!isValidSignature) {
      return renderError(403, "Invalid redirect signature");
    }

    let destination;
    try {
      destination = decodeBase64UrlToString(encodedDestination);
    } catch {
      return renderError(400, "Unable to decode destination URL");
    }

    if (!isSafeRedirectDestination(destination)) {
      return renderError(400, "Unsafe redirect destination");
    }

    return Response.redirect(destination, 302);
  }
};

async function verifySignature(secret, encodedDestination, nonce, signature) {
  const expected = await signPayload(secret, `${REDIRECT_VERSION}.${nonce}.${encodedDestination}`);
  return timingSafeEqual(expected, signature);
}

async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return encodeBytesAsBase64Url(new Uint8Array(signature));
}

function isSafeRedirectDestination(destination) {
  try {
    const url = new URL(destination);
    if (!/^https?:$/i.test(url.protocol)) {
      return false;
    }

    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

function isPrivateHost(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized === "::1"
    || normalized === "[::1]"
  ) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})(?:\.(\d{1,3}))(?:\.(\d{1,3}))(?:\.(\d{1,3}))$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((part) => part < 0 || part > 255)) {
      return true;
    }

    const [first, second] = octets;
    return (
      first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
    );
  }

  const compact = normalized.replace(/^\[|\]$/g, "");
  return (
    compact.startsWith("fc")
    || compact.startsWith("fd")
    || compact.startsWith("fe8")
    || compact.startsWith("fe9")
    || compact.startsWith("fea")
    || compact.startsWith("feb")
  );
}

function encodeBytesAsBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function decodeBase64UrlToString(value) {
  const normalized = String(value)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return textDecoder.decode(bytes);
}

function timingSafeEqual(left, right) {
  const leftValue = String(left || "");
  const rightValue = String(right || "");
  const length = Math.max(leftValue.length, rightValue.length);
  let mismatch = leftValue.length === rightValue.length ? 0 : 1;

  for (let index = 0; index < length; index += 1) {
    const leftCode = leftValue.charCodeAt(index) || 0;
    const rightCode = rightValue.charCodeAt(index) || 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

function renderLandingPage(origin) {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Readwise Redirect Worker</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      main {
        max-width: 42rem;
        padding: 2rem;
      }
      code {
        background: rgba(148, 163, 184, 0.14);
        padding: 0.1rem 0.35rem;
        border-radius: 0.35rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Readwise Redirect Worker</h1>
      <p>This Worker only serves signed redirect links for Readwise Save Translated.</p>
      <p>Expected path: <code>${origin}/open?u=...&n=...&s=...&v=v1</code></p>
    </main>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    }
  );
}

function renderError(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
