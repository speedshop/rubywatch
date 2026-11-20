const raw = "https://raw.githubusercontent.com";
const after = (v) => new RegExp(`${v.replaceAll(".", "\\.")}(?![\\d.])`);
const found = (at = null) => ({ at });

async function atom(net, repo, kind = "releases") {
  const xml = await net.text(`https://github.com/${repo}/${kind}.atom`);
  if (xml === null) throw new Error(`no feed for ${repo}`);
  return xml.split("<entry>").slice(1).map((e) => ({
    title: e.match(/<title>([^<]*)</)?.[1] ?? "",
    tag: e.match(/<id>[^<]*\/([^<\/]+)<\/id>/)?.[1] ?? "",
    at: new Date(e.match(/<updated>([^<]+)</)[1]),
    content: e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "",
  }));
}

const earliest = (entries) => (entries.length ? found(new Date(Math.min(...entries.map((e) => e.at)))) : null);

async function rubyBuildRelease(net, v) {
  const entries = await atom(net, "rbenv/ruby-build");
  const match = entries.filter((e) => new RegExp(`Add ${after(v).source}`).test(e.content)).pop();
  return match && { at: match.at, number: Number(match.tag.replace(/\D/g, "")) };
}

async function lastModified(net, url, cost = 1) {
  const res = await net.head(url, { cost });
  return res.ok ? found(res.modified) : null;
}

async function registry(net, tokenUrl, base, v) {
  const { token } = await net.json(tokenUrl);
  const res = await net.head(`${base}/manifests/${v}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  return res.ok ? found() : null;
}

const dockerHub = (net, repo, v) =>
  registry(
    net,
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    `https://registry-1.docker.io/v2/${repo}`,
    v,
  );

async function fileHas(net, url, pattern) {
  const text = await net.text(url);
  if (text === null) throw new Error(`missing ${url}`);
  return pattern.test(text) ? found() : null;
}

const brewFormula = (s) => (s === "4.0" ? "ruby" : `ruby@${s}`);

const lambdaRegistry = "https://public.ecr.aws/v2/lambda/ruby";
const lambdaArchitectures = ["amd64", "arm64"];
const imageIndexTypes = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
const imageManifestTypes = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const BANNER_PREFIX_BYTES = 8 * 1024 * 1024;
const MIN_RUNTIME_LAYER_BYTES = 1024 * 1024;
const patchOf = (version) => Number(version.split(".")[2]);

async function rubyBanner(gzipPrefix, series) {
  const banner = new RegExp(`ruby (${series.replace(".", "\\.")}\\.\\d+) \\(\\d{4}-\\d\\d-\\d\\d revision`);
  const reader = new Blob([gzipPrefix]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder("latin1");
  let tail = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const text = tail + decoder.decode(chunk.value, { stream: true });
      const match = text.match(banner);
      if (match) return match[1];
      tail = text.slice(-80);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  return null;
}

function runtimeLayerCandidates(layers) {
  const likely = layers.at(-2);
  const others = layers.filter((l) => l !== likely && l.size >= MIN_RUNTIME_LAYER_BYTES).sort((a, b) => b.size - a.size);
  return [likely, ...others];
}

function lambdaImageRuby(net, auth, series, digest) {
  return net.remember(`lambda ${digest}`, async () => {
    const image = await net.json(`${lambdaRegistry}/manifests/${digest}`, { headers: { ...auth, accept: imageManifestTypes } });
    const config = await net.json(`${lambdaRegistry}/blobs/${image.config.digest}`, { headers: auth });
    for (const layer of runtimeLayerCandidates(image.layers)) {
      const prefix = await net.bytes(`${lambdaRegistry}/blobs/${layer.digest}`, {
        headers: { ...auth, range: `bytes=0-${BANNER_PREFIX_BYTES - 1}` },
      });
      const ruby = await rubyBanner(prefix, series);
      if (ruby) return { ruby, created: config.created };
    }
    return { ruby: null, created: config.created };
  });
}

async function lambdaImages(net, series) {
  const { token } = await net.json("https://public.ecr.aws/token/");
  const auth = { authorization: `Bearer ${token}` };
  const index = await net.json(`${lambdaRegistry}/manifests/${series}`, { headers: { ...auth, accept: imageIndexTypes } });
  const images = index.manifests.filter((m) => lambdaArchitectures.includes(m.platform.architecture));
  if (images.length !== lambdaArchitectures.length) throw new Error(`lambda/ruby:${series} is missing an architecture`);
  return Promise.all(images.map((m) => lambdaImageRuby(net, auth, series, m.digest)));
}

async function lambdaProbe(net, { version, series }) {
  const images = await lambdaImages(net, series);
  if (images.some((image) => !image.ruby)) throw new Error(`no Ruby version found in lambda/ruby:${series}`);
  if (!images.every((image) => patchOf(image.ruby) >= patchOf(version))) return null;
  return found(new Date(Math.max(...images.map((image) => Date.parse(image.created)))));
}

export const groups = [
  {
    name: "Installers and version managers",
    targets: [
      {
        id: "ruby-build",
        name: "ruby-build",
        note: "rbenv, and mise when compiling",
        url: "https://github.com/rbenv/ruby-build/releases",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          return release ? found(release.at) : null;
        },
      },
      {
        id: "ruby-builder",
        name: "ruby/ruby-builder binaries",
        url: "https://github.com/ruby/ruby-builder/releases/tag/ruby-{v}",
        probe: (net, { version: v }) =>
          lastModified(net, `https://github.com/ruby/ruby-builder/releases/download/ruby-${v}/ruby-${v}-ubuntu-24.04-x64.tar.gz`, 2),
      },
      {
        id: "brew-ruby-build",
        name: "Homebrew ruby-build",
        url: "https://formulae.brew.sh/formula/ruby-build",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          if (!release) return null;
          const formula = await net.json("https://formulae.brew.sh/api/formula/ruby-build.json");
          return Number(formula.versions.stable) >= release.number ? found() : null;
        },
      },
      {
        id: "asdf",
        name: "asdf",
        url: "https://github.com/asdf-vm/asdf-ruby/commits/master",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          if (!release) return null;
          const utils = await net.text(`${raw}/asdf-vm/asdf-ruby/master/lib/utils.sh`);
          return Number(utils.match(/ASDF_RUBY_BUILD_VERSION:-v(\d+)/)[1]) >= release.number ? found() : null;
        },
      },
      {
        id: "jdx",
        name: "jdx/ruby binaries",
        note: "mise's precompiled Rubies",
        url: "https://github.com/jdx/ruby/releases/tag/{v}",
        probe: async (net, { version }) => earliest((await atom(net, "jdx/ruby")).filter((e) => e.title === version)),
      },
      {
        id: "rubyinstaller",
        name: "RubyInstaller",
        note: "Windows",
        url: "https://github.com/oneclick/rubyinstaller2/releases",
        probe: async (net, { version }) =>
          earliest((await atom(net, "oneclick/rubyinstaller2")).filter((e) => e.tag.startsWith(`RubyInstaller-${version}-`))),
      },
      {
        id: "rvm",
        name: "RVM",
        url: "https://github.com/rvm/rvm/commits/master/config/known",
        probe: async (net, { version }) => {
          const known = await net.text(`${raw}/rvm/rvm/master/config/known`);
          return after(`ruby-${version}`).test(known.replace(/[[\]]/g, "")) ? found() : null;
        },
      },
      {
        id: "rv",
        name: "rv",
        url: "https://github.com/spinel-coop/rv-ruby/releases",
        probe: (net, { version: v }) =>
          lastModified(net, `https://github.com/spinel-coop/rv-ruby/releases/latest/download/ruby-${v}.x86_64_linux.tar.gz`, 3),
      },
      {
        id: "ruby-install",
        name: "ruby-install",
        note: "version metadata",
        url: "https://github.com/postmodern/ruby-versions/commits/master",
        probe: async (net, { version }) => {
          const versions = await net.text(`${raw}/postmodern/ruby-versions/master/ruby/versions.txt`);
          return versions.split("\n").includes(version) ? found() : null;
        },
      },
    ],
  },
  {
    name: "Container images",
    targets: [
      {
        id: "rubylang",
        name: "rubylang/ruby",
        note: "by the Ruby core team",
        url: "https://hub.docker.com/r/rubylang/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "rubylang/ruby", version),
      },
      {
        id: "passenger",
        name: "Phusion Passenger",
        note: "phusion/passenger-ruby images, latest tag",
        url: "https://github.com/phusion/passenger-docker",
        probe: async (net, { version, series }) => {
          const [release] = await atom(net, "phusion/passenger-docker");
          const ruby = await net.head(`${raw}/phusion/passenger-docker/${release.tag}/image/ruby-${version}.sh`);
          if (!ruby.ok) return null;
          return dockerHub(net, `phusion/passenger-ruby${series.replace(".", "")}`, release.tag.replace("rel-", ""));
        },
      },
      {
        id: "grubruby",
        name: "grubruby-jemalloc",
        note: "Ruby base image with bundled jemalloc",
        url: "https://github.com/kaspergrubbe/grubruby-jemalloc/releases",
        probe: async (net, { version }) => {
          const [release] = await atom(net, "kaspergrubbe/grubruby-jemalloc");
          return dockerHub(net, "kaspergrubbe/grubruby-jemalloc", `${version}.${release.tag.replace(/^v/, "")}`);
        },
      },
      {
        id: "bitnami",
        name: "bitnami/ruby",
        url: "https://github.com/bitnami/containers/commits/main/bitnami/ruby",
        series: ["4.0"],
        probe: async (net, { version, series }) => {
          const dockerfile = await net.text(`${raw}/bitnami/containers/main/bitnami/ruby/${series}/debian-12/Dockerfile`);
          if (!dockerfile.includes(`image.version="${version}"`)) return null;
          return found(new Date(dockerfile.match(/image\.created="([^"]+)"/)[1]));
        },
      },
      {
        id: "chainguard",
        name: "Chainguard ruby",
        note: "paid image, checks the Wolfi package it is built from",
        url: "https://images.chainguard.dev/directory/image/ruby/versions",
        probe: (net, { version, series }) =>
          lastModified(net, `https://packages.wolfi.dev/os/x86_64/ruby-${series}-${version}-r0.apk`),
      },
      {
        id: "sorah-image",
        name: "sorah/ruby",
        note: "built from sorah-rbpkg",
        url: "https://gallery.ecr.aws/sorah/ruby",
        probe: (net, { version }) =>
          registry(net, "https://public.ecr.aws/token/", "https://public.ecr.aws/v2/sorah/ruby", version),
      },
      {
        id: "alpine-ruby",
        name: "bkuhlmann/alpine-ruby",
        url: "https://github.com/bkuhlmann/docker-alpine-ruby",
        series: ["4.0"],
        probe: (net, { version }) =>
          fileHas(net, `${raw}/bkuhlmann/docker-alpine-ruby/main/Dockerfile`, new RegExp(`RUBY_VERSION=${after(version).source}`)),
      },
      {
        id: "devcontainer",
        name: "rails/devcontainer",
        url: "https://github.com/rails/devcontainer/pkgs/container/devcontainer%2Fimages%2Fruby",
        probe: (net, { version }) =>
          registry(
            net,
            "https://ghcr.io/token?scope=repository:rails/devcontainer/images/ruby:pull",
            "https://ghcr.io/v2/rails/devcontainer/images/ruby",
            version,
          ),
      },
      {
        id: "docker-official",
        name: "ruby",
        note: "Docker official image",
        url: "https://hub.docker.com/_/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "library/ruby", version),
      },
    ],
  },
  {
    name: "CI",
    targets: [
      {
        id: "mise-action",
        name: "GitHub Actions mise-action",
        note: "Linux and macOS",
        url: "https://github.com/jdx/ruby/releases/tag/{v}",
        sameAs: "jdx",
      },
      {
        id: "heroku-ci",
        name: "Heroku CI",
        note: "Heroku's buildpack",
        url: "https://devcenter.heroku.com/articles/heroku-ci",
        sameAs: "heroku",
      },
      {
        id: "setup-ruby",
        name: "GitHub Actions setup-ruby",
        note: "Linux and macOS",
        url: "https://github.com/ruby/setup-ruby/releases",
        probe: async (net, { version }) => {
          const versions = await net.json(`${raw}/ruby/setup-ruby/v1/ruby-builder-versions.json`);
          return versions.ruby.includes(version) ? found() : null;
        },
      },
      {
        id: "cimg",
        name: "CircleCI cimg/ruby",
        url: "https://hub.docker.com/r/cimg/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "cimg/ruby", version),
      },
      {
        id: "setup-ruby-windows",
        name: "GitHub Actions setup-ruby",
        note: "Windows",
        url: "https://github.com/ruby/setup-ruby/releases",
        probe: async (net, { version }) => {
          const versions = await net.json(`${raw}/ruby/setup-ruby/v1/windows-versions.json`);
          return version in versions ? found() : null;
        },
      },
    ],
  },
  {
    name: "Hosting platforms",
    targets: [
      {
        id: "render",
        name: "Render",
        note: "compiles any version from the tarball",
        url: "https://gist.github.com/nateberkopec/e8cdf967980d4c00d0592c140e3fd012",
        immediate: true,
      },
      {
        id: "heroku",
        name: "Heroku",
        url: "https://devcenter.heroku.com/changelog",
        probe: (net, { version: v }) =>
          lastModified(net, `https://heroku-buildpack-ruby.s3.us-east-1.amazonaws.com/heroku-24/amd64/ruby-${v}.tgz`),
      },
      {
        id: "digitalocean",
        name: "DigitalOcean App Platform",
        note: "Heroku's buildpack",
        url: "https://docs.digitalocean.com/products/app-platform/reference/buildpacks/ruby/",
        sameAs: "heroku",
      },
      {
        id: "northflank",
        name: "Northflank",
        note: "Heroku builder",
        url: "https://northflank.com/docs/v1/application/build/build-with-buildpacks",
        sameAs: "heroku",
      },
      {
        id: "scalingo",
        name: "Scalingo",
        url: "https://github.com/Scalingo/ruby-buildpack",
        probe: (net, { version: v }) => lastModified(net, `https://ruby-binaries.scalingo.com/scalingo-24/amd64/ruby-${v}.tgz`),
      },
      {
        id: "hatchbox",
        name: "Hatchbox",
        note: "compiles via ruby-build",
        url: "https://hatchbox.relationkit.io/articles/26-how-do-i-specify-a-ruby-version-for-my-app",
        sameAs: "ruby-build",
      },
      {
        id: "railway",
        name: "Railway",
        note: "Railpack compiles via mise once mise lists the version",
        url: "https://railpack.com/languages/ruby#precompiled-ruby",
        probe: async (net, { version }) => {
          const listed = new RegExp(`^"${version.replaceAll(".", "\\.")}" =`, "m");
          let first = null;
          for (const commit of (await atom(net, "jdx/mise-versions", "commits/main/docs/ruby.toml")).slice(0, 4)) {
            const file = await net.text(`${raw}/jdx/mise-versions/${commit.tag}/docs/ruby.toml`);
            if (!listed.test(file ?? "")) break;
            first = commit;
          }
          return first && found(first.at);
        },
      },
      {
        id: "fly-kamal",
        name: "Fly.io, Kamal",
        note: "Rails' default Dockerfile, anything on the Docker official image",
        url: "https://hub.docker.com/_/ruby/tags?name={v}",
        sameAs: "docker-official",
      },
      {
        id: "gcp",
        name: "Google Cloud",
        note: "Cloud Run, App Engine",
        url: "https://console.cloud.google.com/artifacts/docker/serverless-runtimes/us/runtimes-ubuntu2404/ruby",
        probe: async (net, { version }) => {
          const list = await net.json("https://us-docker.pkg.dev/v2/serverless-runtimes/runtimes-ubuntu2404/ruby/tags/list");
          const image = Object.values(list.manifest).find((m) => m.tag.includes(version));
          return image ? found(new Date(Number(image.timeUploadedMs))) : null;
        },
      },
      {
        id: "beanstalk",
        name: "AWS Elastic Beanstalk",
        url: "https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html#platforms-supported.ruby",
        probe: (net, { version }) =>
          fileHas(net, "https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html", after(`Ruby ${version}`)),
      },
      {
        id: "lambda",
        name: "AWS Lambda",
        note: "reads the Ruby inside the amd64 and arm64 base images",
        url: "https://gallery.ecr.aws/lambda/ruby",
        probe: lambdaProbe,
      },
    ],
  },
  {
    name: "System packages",
    targets: [
      {
        id: "snap",
        name: "Snap",
        url: "https://snapcraft.io/ruby",
        probe: async (net, { version, series }) => {
          const info = await net.json("https://api.snapcraft.io/v2/snaps/info/ruby?architecture=amd64&fields=version", {
            headers: { "snap-device-series": "16" },
          });
          const channel = info["channel-map"].find((c) => c.channel.name === `${series}/stable` && c.version === version);
          return channel ? found(new Date(channel.channel["released-at"])) : null;
        },
      },
      {
        id: "sorah-rbpkg",
        name: "sorah-rbpkg",
        note: "APT packages for Ubuntu and Debian",
        url: "https://github.com/sorah-rbpkg/ruby/releases",
        probe: async (net, { version }) => {
          const res = await net.head(`https://github.com/sorah-rbpkg/ruby/releases/tag/debian%2F${version}-0nkmi1_noble`);
          return res.ok ? found() : null;
        },
      },
      {
        id: "brew",
        name: "Homebrew",
        url: "https://formulae.brew.sh/formula/ruby",
        probe: async (net, { version, series }) => {
          const formula = await net.json(`https://formulae.brew.sh/api/formula/${brewFormula(series)}.json`);
          return formula?.versions.stable === version ? found() : null;
        },
      },
      {
        id: "nixpkgs",
        name: "nixpkgs",
        url: "https://github.com/NixOS/nixpkgs/commits/master/pkgs/development/interpreters/ruby/default.nix",
        series: ["4.0", "3.4"],
        probe: (net, { version }) =>
          fileHas(
            net,
            `${raw}/NixOS/nixpkgs/master/pkgs/development/interpreters/ruby/default.nix`,
            new RegExp(`rubyVersion ${version.split(".").map((n) => `"${n}"`).join(" ")} ""`),
          ),
      },
      {
        id: "fedora",
        name: "Fedora",
        note: "Rawhide",
        url: "https://packages.fedoraproject.org/pkgs/ruby/ruby/",
        series: ["4.0"],
        probe: async (net, { version }) => {
          const pkg = await net.json("https://mdapi.fedoraproject.org/rawhide/pkg/ruby");
          return pkg.version === version ? found() : null;
        },
      },
      {
        id: "winget",
        name: "winget",
        url: "https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RubyInstallerTeam/Ruby",
        probe: async (net, { version, series }) => {
          const dir = `${raw}/microsoft/winget-pkgs/master/manifests/r/RubyInstallerTeam/Ruby/${series.replace(".", "/")}`;
          const res = await net.head(`${dir}/${version}-1/RubyInstallerTeam.Ruby.${series}.installer.yaml`);
          return res.ok ? found() : null;
        },
      },
      {
        id: "arch",
        name: "Arch Linux",
        url: "https://archlinux.org/packages/extra/x86_64/ruby/",
        series: ["3.4"],
        probe: async (net, { version }) => {
          const pkg = await net.json("https://archlinux.org/packages/extra/x86_64/ruby/json/");
          return pkg.pkgver === version ? found(new Date(pkg.last_update)) : null;
        },
      },
      {
        id: "alpine",
        name: "Alpine Linux",
        note: "edge",
        url: "https://pkgs.alpinelinux.org/packages?name=ruby&branch=edge&arch=x86_64",
        series: ["3.4"],
        probe: (net, { version }) =>
          fileHas(
            net,
            "https://pkgs.alpinelinux.org/packages?name=ruby&branch=edge&arch=x86_64",
            new RegExp(`<td class="version">[^<]*<[^>]*>${version.replaceAll(".", "\\.")}-r\\d+<`),
          ),
      },
      {
        id: "debian",
        name: "Debian",
        note: "any suite, including experimental and proposed updates",
        url: "https://tracker.debian.org/pkg/ruby{s}",
        series: ["3.4", "3.3"],
        probe: async (net, { version, series }) => {
          const src = await net.json(`https://sources.debian.org/api/src/ruby${series}/`);
          return src.versions.some((v) => v.version.startsWith(`${version}-`)) ? found() : null;
        },
      },
      {
        id: "ubuntu",
        name: "Ubuntu",
        note: "any series",
        url: "https://launchpad.net/ubuntu/+source/ruby{s}",
        series: ["3.3"],
        probe: async (net, { version, series }) => {
          const { entries } = await net.json(
            `https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedSources&source_name=ruby${series}&exact_match=true&status=Published&ws.size=50`,
          );
          const published = entries.filter((e) => e.source_package_version.startsWith(`${version}-`));
          return earliest(published.map((e) => ({ at: new Date(e.date_published) })));
        },
      },
    ],
  },
];

export const targets = groups.flatMap((g) => g.targets);
