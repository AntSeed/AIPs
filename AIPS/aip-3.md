---
aip: 3
title: Pluggable Verifier SDKs
description: Defines pluggable verifier SDKs and the attestation handshake buyers use to verify seller nodes.
author: Essam Hassan (@essamhassan)
discussions-to: https://github.com/AntSeed/antseed/pull/713
status: Final
type: Standards Track
category: Interface
created: 2026-07-13
---

## Abstract

This AIP adds a pluggable verifier-SDK system to AntSeed, letting any party ship
a verifier that a buyer runs to cryptographically attest a seller before routing
paid requests to it. A typical use is confirming the seller runs inside a genuine
Trusted Execution Environment, though verifiers can attest claims well beyond TEEs.

A verifier SDK is one package with two parts: a *verifier* that runs on the buyer
and a *prover* that runs on the seller. The buyer picks one curated SDK and trusts
its verdict. The SDK is self-contained and talks to the seller over the
existing buyer-to-seller connection, so no new transport is added. Sellers
advertise the verifier ids they support as peer capabilities and load the
matching prover at startup. A buyer only runs a verifier that the seller
advertises and that sits in the buyer's curated trust set, driving it against a
reserved attestation route.

This proposal defines the verifier and prover interfaces, the reserved route and
its dispatch rules, the capability format, the buyer policy (verification on by
default, best-effort, with opt-in enforcement), and the curation and
version-pinning rules that bound what verifier code a buyer will run. The
verification schemes themselves stay in the SDKs.

## Motivation

Buyers route paid inference to sellers they discover over an open P2P network.
Reputation and payment prove a seller was paid and rated, but not what it is
actually running. Before sending traffic or sensitive prompts, some buyers want a
cryptographic guarantee: that the seller runs in a specific confidential-computing
environment, serves a specific model, or meets some other machine-checkable
claim.

Verification methods change fast and vary by trust domain: TEE attestation (Intel
TDX via DCAP today, others later), reproducible-build measurement, model
fingerprinting. Hard-coding one scheme into the protocol would freeze it early and
force every implementation to carry every verifier. Verification code is also
security-critical: a buyer that runs an attacker-chosen verifier gains nothing.

So the protocol needs to:

- let anyone publish a verification scheme as an SDK;
- let sellers advertise which schemes they can prove;
- let buyers run a chosen scheme against a seller over the existing connection,
  with no new transport and no metered request;
- keep the trust surface small, so a buyer only runs verifier code it has curated
  and pinned.

This AIP specifies that mechanism and leaves the schemes to their SDKs.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

### Verifier and Prover Plugins

A verifier SDK exports a verifier (buyer side) and a prover (seller side). The
verifier MUST implement:

```typescript
interface AntseedVerifierPlugin {
  type: 'verifier'
  name: string
  displayName: string
  version: string
  description: string
  verify(ctx: VerifyContext): VerifyResult | Promise<VerifyResult>
}

interface VerifyContext {
  peerId: string
  verifierId: string   // selected by the buyer; MUST equal the SDK's name
  attestPath: string   // reserved route this verifier proves against
  fetchFromSeller(req: SellerRequest): Promise<SellerResponse>
  signal?: AbortSignal
}

interface VerifyResult {
  ok: boolean
  claims: { claim: string; ok: boolean; detail?: string }[]
}
```

The prover MUST implement:

```typescript
interface Prover {
  type: 'prover'
  name: string
  displayName: string
  version: string
  description: string
  prove(req: SellerRequest): SellerResponse | Promise<SellerResponse>
}
```

`SellerRequest` is `{ method, path, headers?, body? }` and `SellerResponse` is
`{ statusCode, headers, body }`, with byte-array bodies. A verifier MUST reach the
seller only through `ctx.fetchFromSeller` and MUST NOT open its own transport,
which keeps it self-contained but confined to the existing channel.

A package MAY export both halves. A loader MUST pick the export whose `type`
matches the requested kind (`verifier` or `prover`) and MUST reject a package that
exposes more than one distinct export of that kind.

### Reserved Attestation Route

The path prefix `/_antseed/attest` (`ANTSEED_ATTEST_PATH`) is reserved. A seller
MUST route a request for `"/_antseed/attest/" + verifierId` to the loaded prover
whose `name` equals `verifierId`, and MUST do so before provider matching and
before any payment or metering. Attestation is free and unmetered.

Dispatch rules:

- An undecodable attest path (bad percent-encoding) MUST return `400`.
- A decodable `verifierId` with no loaded prover of that `name` MUST return `404`
  with error code `prover_not_found`.
- Otherwise the seller MUST call `prove()` and return its `SellerResponse`. A
  prover error MUST come back as a `500` response of type `verifier_error` and
  MUST NOT crash request handling.

A seller MUST NOT advertise a verifier id unless it has loaded a prover with the
matching `name`; the two are bound at startup.

### Attestation Rate Limit

Quote generation can be costly, so a seller MUST rate-limit the prove path per
buyer peer. The reference bound is 10 attestations per 60-second window per peer,
with the tracking table capped (1024 peers) so the limiter cannot itself become a
memory-exhaustion vector. Cheap `400`/`404` rejections MUST NOT count against a
buyer's quota; only `prove()` does.

### Capability Advertisement

A seller announces support as peer capability strings:

- `verifier.<id>` for each supported id;
- `verifier-default.<id>` for its default id (the first configured).

Ids MUST be lowercase `[a-z0-9]` segments joined by hyphens or dots, with no `@`,
`/`, or whitespace. The dot separator keeps them inside the existing capability
grammar, so discovery is unchanged. A buyer reads these to learn a seller's
supported set and default.

### Buyer Verification Policy

Three options control the buyer, and they constrain each other:

- `--verifiers <a,b,c>`: an ordered preference list of ids.
- `--require-verifier`: refuse to route to a seller unless a verifier verifies it.
- `--no-verifier`: turn verification off. Pairing it with `--require-verifier` or
  `--verifiers` is contradictory and MUST be rejected.

With no flag, the buyer verifies but still routes: it tries the seller's
advertised default id when that id is in its curated trust set, and routes
regardless of the result. `--require-verifier` turns a failed or missing
verification into a block.

For each seller the buyer selects a verifier id from those the seller advertises,
following `--verifiers` order when set and otherwise the seller's advertised
default. A buyer MUST run only curated code: it loads the selected id from its
curated, version-pinned trust set, prepared ahead of use and never installed on
the request path, so an id outside that set fails to load and is never run. With
no `--verifiers` flag it selects only among curated ids to begin with. The buyer
MUST check that the loaded SDK's `name` equals the selected id, then run
`verify()` with the client's abort signal forwarded under a bounded timeout (30
seconds in the reference). Verdicts MAY be cached by `(peerId, verifier-support
fingerprint)`, but a transient failure MUST NOT be cached as a negative verdict.

### Curation and Version Pinning

A buyer MUST run only verifier code from its curated trust set: a client-shipped
map from verifier id to an exact npm package and version. It MUST install and load
the pinned version, MUST reject a version mismatch, and MUST NOT auto-upgrade to a
floating latest. Sellers MAY load any prover they like; the trust decision is the
buyer's alone, and a seller-advertised id that is not in the buyer's set is never
selected.

## Rationale

**One SDK, trusted whole.** The buyer commits to a single verifier per seller and
takes its verdict as-is. The trust boundary is one decision, which curated SDK to
run, and everything the verdict rests on lives inside that SDK's `verify()`.

**Self-contained over the existing channel.** Handing the verifier a
`fetchFromSeller` closure rather than raw network access lets it run any
challenge/response it wants while staying on the connection the protocol already
secures and rate-limits. No new transport, port, or discovery surface appears.

**Prover as its own role.** The prover is its own plugin type served on a
reserved, pre-payment route, so attestation stays out of the seller's
inference-pricing config and is free by construction: the verdict never passes
through provider matching or metering.

**Selection from capabilities.** Advertising `verifier.<id>` and
`verifier-default.<id>` lets buyers spot seller support during normal discovery
and choose a scheme with no extra handshake. Dotted ids fit the existing grammar,
so discovery stays the same.

**On by default, best-effort.** Verification runs by default but does not block,
so buyers get signal without depending on every seller supporting a scheme, while
`--require-verifier` gives strict buyers a hard gate. This is how
optional-but-preferred features tend to roll out on an open network.

**Pinning over flexibility.** Provider and router plugins are just config;
verifier SDKs are trust anchors. Pinning the exact version and rejecting drift
makes the buyer's trust decision reproducible and stops an upstream publish from
quietly changing what runs.

## Backwards Compatibility

This proposal is additive. A seller with no verifier advertises no `verifier.*`
capabilities and is unaffected; a buyer passing `--no-verifier` behaves exactly as
before. The `/_antseed/attest` prefix is newly reserved, so sellers MUST NOT route
it to providers, though it was never a valid service path anyway. No metadata
codec or payment change is needed. Mixed-version networks interoperate: a
verifier-aware buyer skips sellers that advertise none, and a verifier-advertising
seller is ignored by buyers that do not care.

## Test Cases

A conforming implementation MUST include tests for:

- prover dispatch on `/_antseed/attest/<id>` before provider matching and payment;
- `400` on an undecodable attest path, `404` `prover_not_found` on an empty or
  unknown id, and a `500` `verifier_error` on prover failure;
- per-buyer attestation rate limiting, with cheap rejections not consuming quota;
- capability round-trip: building and parsing `verifier.<id>` and
  `verifier-default.<id>`;
- policy resolution, including rejection of `--no-verifier` combined with
  `--require-verifier` or `--verifiers`;
- default-path selection restricted to curated seller-advertised ids, and a
  non-curated or unprepared id never run;
- the loaded SDK's name equalling the selected id, and rejection of a version
  mismatch;
- verdict caching keyed by peer and support fingerprint, skipping transient
  failures;
- a multi-export loader selecting by `type` and rejecting ambiguous packages.

## Reference Implementation

Reference implementation: https://github.com/AntSeed/antseed/pull/713

Key surfaces:

- `AntseedVerifierPlugin`, `Prover`, `VerifyContext`, and `ANTSEED_ATTEST_PATH` in
  `@antseed/node`;
- reserved-route dispatch in the seller request handler and `registerProver` on
  the node;
- buyer selection, policy, caching, and timeout logic in the CLI verifier module;
- the curated trust set (`TRUSTED_VERIFIER_PLUGINS`) and the multi-export plugin
  loader.

## Security Considerations

The buyer runs verifier code, so the trust surface is the curated set, not the
seller. A buyer MUST run only SDKs it has curated and pinned, and never loads a
seller-advertised id outside that set. Pinning the exact version and rejecting
drift stops an upstream publish from silently changing what runs, and checking
that the loaded SDK's `name` equals the chosen id stops a swapped package from
posing as a trusted verifier.

The attestation route is free and runs before payment, which is a denial-of-service
surface: unmetered `prove()` calls can be expensive (TEE quote generation).
Sellers MUST rate-limit the prove path per buyer peer and MUST bound the tracking
state so the limiter cannot itself be turned into a memory-exhaustion vector.
Malformed or unknown-id requests are rejected cheaply and MUST NOT consume quota.

Verification rides the existing buyer-to-seller channel through `fetchFromSeller`.
A verifier MUST NOT open its own transport, so it inherits the channel's
authentication and cannot pivot elsewhere. `verify()` MUST run under a bounded
timeout with the client abort signal forwarded, so a slow or hostile seller cannot
stall the buyer.

A verdict is only as strong as the SDK behind it. One that returns `ok: true`
without a real cryptographic check gives false assurance, so curation is what makes
a verdict mean anything. Default-on verification is signal rather than a gate:
buyers that need a guarantee MUST use `--require-verifier`, which refuses to route
on a failed or absent verification. Cached verdicts MUST be keyed to the peer's
verifier-support fingerprint and MUST NOT store a transient failure as negative, so
a momentary error neither pins a stale pass nor locks out a good seller.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).
