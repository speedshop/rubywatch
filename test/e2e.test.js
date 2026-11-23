import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";

const root = new URL("..", import.meta.url).pathname;
const wrangler = JSON.parse(readFileSync(`${root}wrangler.json`, "utf8"));

const INDEX = [
  "ruby-4.0.9\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.9.tar.gz\tsha",
  "ruby-4.0.10\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.10.tar.gz\tsha",
  "ruby-4.0.11\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.11.tar.xz\tsha",
  "ruby-3.4.13\thttps://cache.ruby-lang.org/pub/ruby/3.4/ruby-3.4.13.tar.gz\tsha",
  "ruby-3.3.14\thttps://cache.ruby-lang.org/pub/ruby/3.3/ruby-3.3.14.tar.gz\tsha",
  "",
].join("\n");
const TARBALL = "Wed, 18 Nov 2026 23:34:42 GMT";
const BUILDER = "Wed, 18 Nov 2026 23:45:42 GMT";
const WOLFI = "Thu, 19 Nov 2026 02:17:57 GMT";
const AMD64_BUILT = "2026-11-19T12:54:36.377Z";
const ARM64_BUILT = "2026-11-19T13:20:00.000Z";
const LAMBDA_IMAGES = {
  "4.0": { amd64: "4.0.10", arm64: "4.0.10" },
  "3.4": { amd64: "3.4.13", arm64: "3.4.12" },
  "3.3": { amd64: "3.3.15", arm64: "3.3.15", rubyFirst: true },
};
const ECR = "https://public.ecr.aws/v2/lambda/ruby";
const MB = 1024 * 1024;

const gzipped = (text) => gzipSync(Buffer.from(`${"\0".repeat(4096)}${text}${"\0".repeat(4096)}`));

function lambdaRegistry(url) {
  const [kind, ref] = url.pathname.split("/").slice(-2);
  if (kind === "manifests" && ref in LAMBDA_IMAGES) {
    return Response.json({
      manifests: ["amd64", "arm64"].map((architecture) => ({ digest: `sha256:image-${ref}-${architecture}`, platform: { architecture } })),
    });
  }
  const [, what, series, architecture] = ref.match(/^sha256:(\w+)-([\d.]+)-(\w+)$/) ?? [];
  const image = LAMBDA_IMAGES[series];
  if (what === "image") {
    const ruby = { digest: `sha256:ruby-${series}-${architecture}`, size: 80 * MB };
    const docs = { digest: `sha256:docs-${series}-${architecture}`, size: 70 * MB };
    const entrypoint = { digest: `sha256:entrypoint-${series}-${architecture}`, size: 4 * MB };
    return Response.json({
      config: { digest: `sha256:config-${series}-${architecture}` },
      layers: image.rubyFirst ? [ruby, docs, entrypoint] : [docs, ruby, entrypoint],
    });
  }
  if (what === "config") return Response.json({ created: architecture === "arm64" ? ARM64_BUILT : AMD64_BUILT });
  if (what === "ruby") {
    return new Response(gzipped(`ruby ${image[architecture]} (2026-11-19 revision a704b7cd95) +PRISM [${architecture}-linux]`), { status: 206 });
  }
  if (what === "docs") return new Response(gzipped("ruby 2.5.9 is mentioned in old release notes"), { status: 206 });
  return new Response(null, { status: 404 });
}

const requests = [];

function upstream(request) {
  const url = new URL(request.url);
  requests.push(url.href);
  if (url.href === "https://cache.ruby-lang.org/pub/ruby/index.txt") return new Response(INDEX);
  if (url.hostname === "cache.ruby-lang.org") return new Response(null, { headers: { "last-modified": TARBALL } });
  if (url.href === "https://github.com/rbenv/ruby-build/releases.atom") return new Response("<feed></feed>");
  if (url.href === "https://public.ecr.aws/token/") return Response.json({ token: "token" });
  if (url.href.startsWith(ECR)) return lambdaRegistry(url);
  if (url.pathname.startsWith("/ruby/ruby-builder/releases/download/")) {
    return new Response(null, { headers: { "last-modified": BUILDER } });
  }
  if (url.href === "https://packages.wolfi.dev/os/x86_64/ruby-4.0-4.0.10-r0.apk") {
    return new Response(null, { headers: { "last-modified": WOLFI } });
  }
  if (url.href === "https://github.com/phusion/passenger-docker/releases.atom") {
    return new Response(
      "<feed><entry><id>tag:github.com,2008:Repository/14279525/rel-3.2.4</id><updated>2026-11-19T02:00:00Z</updated><title>rel-3.2.4</title></entry></feed>",
    );
  }
  if (url.href === "https://raw.githubusercontent.com/phusion/passenger-docker/rel-3.2.4/image/ruby-4.0.10.sh") return new Response(null);
  if (url.href === "https://raw.githubusercontent.com/phusion/passenger-docker/rel-3.2.4/image/ruby-3.4.13.sh") return new Response(null);
  if (url.hostname === "auth.docker.io" && url.searchParams.get("scope")?.startsWith("repository:phusion/")) return Response.json({ token: "token" });
  if (url.href === "https://registry-1.docker.io/v2/phusion/passenger-ruby40/manifests/3.2.4") return new Response(null);
  if (url.href === "https://github.com/kaspergrubbe/grubruby-jemalloc/releases.atom") {
    return new Response(
      "<feed><entry><id>tag:github.com,2008:Repository/152586269/v9051</id><updated>2026-11-19T00:48:24Z</updated><title>Version 9051 released</title><content type=\"html\">&lt;li&gt;&lt;code&gt;4.0.10&lt;/code&gt; as &lt;code&gt;kaspergrubbe/grubruby-jemalloc:4.0.10.9051&lt;/code&gt;.&lt;/li&gt; &lt;li&gt;&lt;code&gt;3.4.13&lt;/code&gt; as &lt;code&gt;kaspergrubbe/grubruby-jemalloc:3.4.13.9051&lt;/code&gt;.&lt;/li&gt;</content></entry></feed>",
    );
  }
  if (url.hostname === "auth.docker.io" && url.searchParams.get("scope")?.startsWith("repository:kaspergrubbe/")) return Response.json({ token: "token" });
  if (url.href === "https://registry-1.docker.io/v2/kaspergrubbe/grubruby-jemalloc/manifests/4.0.10.9051") return new Response(null);
  return new Response(null, { status: 404 });
}

let mf;
let worker;

const get = (path) => mf.dispatchFetch(`https://rubywatch.test${path}`);
const runCron = () => worker.scheduled({ cron: "* * * * *" });

async function status() {
  const response = await get(`/api/status?${requests.length}-${Date.now()}`);
  assert.equal(response.status, 200);
  return response.json();
}

const row = (data, id) => data.groups.flatMap((g) => g.targets).find((t) => t.id === id);

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: `${root}src`,
      modules: ["index.js", "net.js", "targets.js", "page.html"].map((name) => ({
        type: name.endsWith(".js") ? "ESModule" : "Text",
        path: `${root}src/${name}`,
      })),
      compatibilityDate: wrangler.compatibility_date,
      d1Databases: ["DB"],
      outboundService: upstream,
    }),
  );
  worker = await mf.getWorker();
  await runCron();
});

after(() => mf?.dispose());

test("a cron round finds the newest release of each series and when it came out", async () => {
  const data = await status();
  assert.deepEqual(
    data.releases.map((r) => [r.version, r.released_at]),
    [
      ["4.0.10", "2026-11-18T23:34:42.000Z"],
      ["3.4.13", "2026-11-18T23:34:42.000Z"],
      ["3.3.14", "2026-11-18T23:34:42.000Z"],
    ],
  );
});

test("a channel that has the release reports the time its source gives", async () => {
  const data = await status();
  const result = row(data, "ruby-builder").results["4.0.10"];
  assert.equal(result.state, "found");
  assert.equal(result.at, "2026-11-18T23:45:42.000Z");
  assert.equal(result.exact, true);
});

test("Chainguard reports the time the Wolfi package was uploaded", async () => {
  const data = await status();
  const results = row(data, "chainguard").results;
  assert.equal(results["4.0.10"].state, "found");
  assert.equal(results["4.0.10"].at, "2026-11-19T02:17:57.000Z");
  assert.equal(results["3.4.13"].state, "waiting");
});

test("a round stays inside its request budget", () => {
  assert.ok(requests.length <= 120, `${requests.length} requests`);
});

test("Passenger reports the Ruby once the latest passenger-docker release ships it and its image is pushed", async () => {
  const data = await status();
  const passenger = row(data, "passenger");
  assert.equal(passenger.results["4.0.10"].state, "found");
  assert.equal(passenger.results["4.0.10"].exact, false);
  assert.equal(passenger.results["3.4.13"].state, "waiting", "released, but the 3.4 image is not pushed yet");
  assert.equal(passenger.results["3.4.13"].checkedAt, data.lastRun);
  assert.equal(passenger.results["3.3.14"].state, "waiting");
});

test("grubruby reports the Ruby once its image is pushed under the latest grubruby release", async () => {
  const data = await status();
  const results = row(data, "grubruby").results;
  assert.equal(results["4.0.10"].state, "found");
  assert.equal(results["4.0.10"].at, "2026-11-19T00:48:24.000Z", "the time the release came out, not when it was first checked");
  assert.equal(results["4.0.10"].exact, true);
  assert.equal(results["3.4.13"].state, "waiting", "listed in the release, but the image is not pushed yet");
  assert.equal(results["3.3.14"].state, "waiting", "not listed in any release");
});

test("a channel that does not have the release yet is waiting, with the time it was checked", async () => {
  const data = await status();
  for (const result of Object.values(row(data, "ruby-build").results)) {
    assert.equal(result.state, "waiting");
    assert.equal(result.checkedAt, data.lastRun);
  }
});


test("a second cron round inside the same minute checks nothing", async () => {
  const before = requests.length;
  await runCron();
  assert.equal(requests.length, before);
});

test("no source is requested more than once in a round", () => {
  assert.equal(new Set(requests).size, requests.length);
});

test("AWS Lambda reads the Ruby inside both architectures of its base image, once per image", async () => {
  const db = await mf.getD1Database("DB");
  for (let round = 0; round < 6; round++) {
    await db.prepare("UPDATE meta SET value = ? WHERE key = 'last_run'").bind(new Date(Date.now() - 120000).toISOString()).run();
    await runCron();
  }
  const { results } = row(await status(), "lambda");
  assert.equal(results["4.0.10"].state, "found");
  assert.equal(results["4.0.10"].at, ARM64_BUILT, "found when the later architecture was built");
  assert.equal(results["3.4.13"].state, "waiting", "arm64 still has 3.4.12");
  assert.equal(results["3.3.14"].state, "found", "a newer patch counts, wherever the Ruby layer sits");

  const count = (url) => requests.filter((r) => r === url).length;
  assert.ok(count(`${ECR}/manifests/3.4`) > 1, "the 3.4 image index is checked again in later rounds");
  const downloads = requests.filter((r) => r.startsWith(`${ECR}/blobs/sha256:ruby-`) || r.startsWith(`${ECR}/blobs/sha256:docs-`));
  assert.equal(new Set(downloads).size, downloads.length, "no layer is downloaded twice");
});

test("the page arrives with its data, the Speedshop link and a cache lifetime", async () => {
  const response = await get("/");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("cache-control"), /^public, max-age=\d+$/);
  const embedded = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.deepEqual(embedded.releases.map((r) => r.version), ["4.0.10", "3.4.13", "3.3.14"]);
  assert.match(html, /href="https:\/\/www\.speedshop\.co\/"/);
  assert.match(html, /<link rel="icon"/);
});

test("other paths and methods are not found", async () => {
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await mf.dispatchFetch("https://rubywatch.test/", { method: "POST" })).status, 404);
});
