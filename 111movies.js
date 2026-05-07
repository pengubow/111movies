import crypto from "crypto";

const BASE_URL = "https://111movies.net";
const USER_AGENT =
"Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0";

const AES_KEY = Buffer.from("75745e6c15fb316b25b34af455421c257c959ba6634cacfbaec0bae019c9a31c", "hex");
const AES_IV = Buffer.from("e26e7bf4549e9d99b169cf740a746e76", "hex");

const XOR_KEY = [31, 53, 243, 172, 244, 229, 114, 181];

const STANDARD_ALPHABET =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const SCRAMBLED_ALPHABET =
"y5OnTckzKWGjIxS608up4F7BYVhimEZJ_NvldPfA9Ha-orQtsMwDUbqgCe3X1RL2";

const API_PATH =
"APA91jIfiZxbFSzcMb2OmfKntpKPy-TQaw46YgiAUfMTO7qIqMPlsvMwYuyxK2MI2l1hlKXncY0YH8bjExtDSa5sg66tqDmP_csCi5B8-575ILXaYz2AeBtgZ7IknLrJwDKxI9OcHUaNXeJTSiugID-0polApBR10PQyX_-4GcuZwv9Sz4pLM9Y/w/1000074138859700/e200457c-4bce-5aa6-a15c-b6d8ab4b7d6c/aloom/7311467556049960822d8991a31d99836652ed0b13eb80175bf8cea462f89666";

const REQUEST_METHOD = "GET";

const DEFAULT_HEADERS = {
  "Content-Type": "application/pdf",
  "X-Requested-With": "XMLHttpRequest",
};

function requestHeaders(method) {
  const headers = { ...DEFAULT_HEADERS };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Length"] = "0";
  }
  return headers;
}

async function request(url, options = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    Referer: BASE_URL + "/",
    ...options.headers,
  };

  if (options.origin !== false) {
    headers.Origin = BASE_URL;
  }

  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
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
    method: REQUEST_METHOD,
    headers: requestHeaders(REQUEST_METHOD),
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
      method: REQUEST_METHOD,
      headers: requestHeaders(REQUEST_METHOD),
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

async function fetchWyzieSubtitles(tmdbId, season, episode) {
  const params = new URLSearchParams({ id: tmdbId });
  if (season && episode) {
    params.set("season", season);
    params.set("episode", episode);
  }

  const res = await request(`${BASE_URL}/wyzie?${params}`, {
    origin: false,
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) return [];

  const subtitles = res.json();
  return Array.isArray(subtitles) ? subtitles : [];
}

async function main() {
  const args = process.argv.slice(2);

  const tmdbId = args[0];
  const season = args[1];
  const episode = args[2];

  if (!tmdbId) {
    console.log("Usage: node 111movies.js <tmdb_id> [season] [episode]");
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

  const subtitles = await fetchWyzieSubtitles(tmdbId, season, episode);
  console.log(`Wyzie subtitles: ${subtitles.length}`);
  for (const subtitle of subtitles) {
    console.log(`${subtitle.language || "?"} ${subtitle.display || ""}: ${subtitle.url || ""}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
});
