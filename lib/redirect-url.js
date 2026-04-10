const REDIRECT_VERSION = "v1";
const DEFAULT_REDIRECT_PATH = "/open";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export {
  DEFAULT_REDIRECT_PATH,
  REDIRECT_VERSION,
  buildSignedRedirectUrl,
  decodeBase64UrlToString,
  decodeRedirectDestination,
  isSafeRedirectDestination,
  normalizeRedirectBaseUrl,
  verifyRedirectSignature
};

async function buildSignedRedirectUrl(baseUrl, originalUrl, secret, nonce = createNonce()) {
  const normalizedBaseUrl = normalizeRedirectBaseUrl(baseUrl);
  const normalizedSecret = String(secret || "").trim();
  const normalizedOriginalUrl = String(originalUrl || "").trim();

  if (!normalizedBaseUrl || !normalizedSecret || !normalizedOriginalUrl) {
    throw new Error("Redirect URL signing requires base URL, original URL, and secret.");
  }

  const encodedDestination = encodeStringAsBase64Url(normalizedOriginalUrl);
  const payload = buildSignaturePayload(encodedDestination, nonce);
  const signature = await signPayload(normalizedSecret, payload);
  const redirectUrl = new URL(DEFAULT_REDIRECT_PATH, normalizedBaseUrl);
  redirectUrl.searchParams.set("v", REDIRECT_VERSION);
  redirectUrl.searchParams.set("u", encodedDestination);
  redirectUrl.searchParams.set("n", nonce);
  redirectUrl.searchParams.set("s", signature);
  return redirectUrl.toString();
}

function decodeRedirectDestination(searchParams) {
  const encodedDestination = searchParams.get("u");
  if (!encodedDestination) {
    return null;
  }

  try {
    return decodeBase64UrlToString(encodedDestination);
  } catch {
    return null;
  }
}

async function verifyRedirectSignature(searchParams, secret) {
  const encodedDestination = searchParams.get("u") || "";
  const nonce = searchParams.get("n") || "";
  const signature = searchParams.get("s") || "";
  const version = searchParams.get("v") || REDIRECT_VERSION;

  if (!encodedDestination || !nonce || !signature || version !== REDIRECT_VERSION) {
    return false;
  }

  const expected = await signPayload(secret, buildSignaturePayload(encodedDestination, nonce));
  return timingSafeEqual(signature, expected);
}

function normalizeRedirectBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const url = new URL(trimmed);
  if (!/^https?:$/i.test(url.protocol)) {
    throw new Error("Redirect base URL must use http or https.");
  }

  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/";
  }

  url.hash = "";
  url.search = "";
  return url.toString();
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

function buildSignaturePayload(encodedDestination, nonce) {
  return `${REDIRECT_VERSION}.${nonce}.${encodedDestination}`;
}

async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(String(payload)));
  return encodeBytesAsBase64Url(new Uint8Array(signature));
}

function encodeStringAsBase64Url(value) {
  return encodeBytesAsBase64Url(textEncoder.encode(String(value)));
}

function decodeBase64UrlToString(value) {
  const bytes = decodeBase64UrlToBytes(value);
  return textDecoder.decode(bytes);
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

function decodeBase64UrlToBytes(value) {
  const normalized = String(value)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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

function createNonce() {
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
