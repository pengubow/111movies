import crypto from "crypto";

const BASE_URL = "https://111movies.net";
const USER_AGENT =
"Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0";

const AES_KEY = Buffer.from("8e0a656f1465c1cec75fc96382ad5187c1e49d10622fc7d3d1a381a31b067cbf", "hex");
const AES_IV = Buffer.from("3f096e5a9f1d9aa3faccd8c6b53b5105", "hex");

const XOR_KEY = [145, 74, 235, 169, 194, 195, 242, 217, 154, 89];

const STANDARD_ALPHABET =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const SCRAMBLED_ALPHABET =
"oz-B7ntbyYZe59mDp08cQHGJ4KrXAWM21Rv_kiw6IfPCVhOTU3LxSENuFjlgasdq";

const API_PATH =
"APA91FFrHH9czauBQ7NGlLSaKGUwgel4KM6D27PLT4kT5zVkUW33QqeWh5aMj3O0he1cnoUSzXsLQCCMqEfLqGu8AZQICEM2DyLrkC9mJsHEp8k_uXDPqAHWAlNHtLq4CcbkS2KHmCOc7c4uPlzg4yICXfmBrWQsj6T3q840fQClpPv9HspuKln";

const CSRF_TOKEN = "Ia5a6GaILGefI2vZL9Sr7WnroH6tPszr";

const DEFAULT_HEADERS = {
  "Content-Type": "application/xml",
  "X-Csrf-Token": CSRF_TOKEN,
  "Content-Length": "0",
};

async function request(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      Referer: BASE_URL + "/",
      Origin: BASE_URL,
      ...options.headers,
    },
    body: options.body,
    redirect: "follow",
  });

  const text = await res.text();

  return {
    ok: res.ok,
    text: () => text,
    json: () => JSON.parse(text),
  };
}

function encodeToken(data) {
  const cipher = crypto.createCipheriv("aes-256-cbc", AES_KEY, AES_IV);

  let encryptedHex = cipher.update(data, "utf8", "hex");
  encryptedHex += cipher.final("hex");

  let xored = "";

  for (let i = 0; i < encryptedHex.length; i++) {
    const charCode = encryptedHex.charCodeAt(i);
    const key = XOR_KEY[i % XOR_KEY.length];
    xored += String.fromCharCode(charCode ^ key);
  }

  let base64 = Buffer.from(xored, "utf8").toString("base64");

  base64 = base64.replace(/\+/g, "-");
  base64 = base64.replace(/\//g, "_");
  base64 = base64.replace(/=/g, "");

  let finalToken = "";

  for (let i = 0; i < base64.length; i++) {
    const char = base64[i];
    const index = STANDARD_ALPHABET.indexOf(char);

    if (index !== -1) {
      finalToken += SCRAMBLED_ALPHABET[index];
    } else {
      finalToken += char;
    }
  }

  return finalToken;
}

function extractPagePropsFromHtml(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );

  if (!match) return null;

  try {
    const json = JSON.parse(match[1]);
    return json.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

async function fetchPageProps(tmdbId, season, episode) {
  const isTV = season && episode;

  let pageUrl;
  if (isTV) {
    pageUrl = `${BASE_URL}/tv/${tmdbId}/${season}/${episode}`;
  } else {
    pageUrl = `${BASE_URL}/movie/${tmdbId}`;
  }

  const res = await request(pageUrl);
  if (!res.ok) throw new Error("Page fetch failed");

  const html = res.text();

  const props = extractPagePropsFromHtml(html);
  if (props && props.data) return props;

  const buildMatch = html.match(/buildId['"_]?\s*:\s*['"]([^'"]+)['"]/);
  if (!buildMatch) throw new Error("buildId not found");

  const buildId = buildMatch[1];

  let dataUrl;
  if (isTV) {
    dataUrl = `${BASE_URL}/_next/data/${buildId}/tv/${tmdbId}/${season}/${episode}.json`;
  } else {
    dataUrl = `${BASE_URL}/_next/data/${buildId}/movie/${tmdbId}.json`;
  }

  const dataRes = await request(dataUrl);
  if (!dataRes.ok) throw new Error("Data fetch failed");

  const json = dataRes.json();
  return json.pageProps;
}

async function fetchSources(token) {
  const url = `${BASE_URL}/${API_PATH}/${token}/sr`;

  const res = await request(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
  });

  if (!res.ok) {
    throw new Error("Sources request failed");
  }

  const sources = res.json();

  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("No sources returned");
  }

  return sources;
}

async function resolveFirstWorkingStream(sources) {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];

    const url = `${BASE_URL}/${API_PATH}/${source.data}`;

    const res = await request(url, {
      method: "POST",
      headers: DEFAULT_HEADERS,
    });

    if (!res.ok) {
      console.log(`✗ ${source.name}`);
      continue;
    }

    try {
      const stream = res.json();

      if (stream && stream.url) {
        return {
          stream: stream,
          sourceName: source.name,
        };
      }
    } catch {}

    console.log(`✗ ${source.name}`);
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);

  const tmdbId = args[0];
  const season = args[1];
  const episode = args[2];

  if (!tmdbId) {
    console.log("Usage: node script.js <tmdb_id> [season] [episode]");
    process.exit(1);
  }

  console.log("Fetching page data...");
  const pageProps = await fetchPageProps(tmdbId, season, episode);

  if (!pageProps || !pageProps.data) {
    throw new Error("No page data");
  }

  console.log("Encoding token...");
  const token = encodeToken(pageProps.data);

  console.log("Fetching sources...");
  const sources = await fetchSources(token);

  console.log(`Found ${sources.length} sources`);

  console.log("Resolving stream...");
  const result = await resolveFirstWorkingStream(sources);

  if (!result) {
    throw new Error("No working stream found");
  }

  console.log(`Working source: ${result.sourceName}`);
  console.log(`m3u8 url: ${result.stream.url}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
});
