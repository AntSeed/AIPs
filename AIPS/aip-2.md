---
aip: 2
title: Recognized Usage Trust
description: Defines the on-chain trust, reputation, and reward system for recognized AntSeed usage.
author: Shahaf Antwarg (@kotevcode)
discussions-to: https://github.com/AntSeed/antseed/pull/632
status: Draft
type: Standards Track
category: Contracts
created: 2026-07-08
---

## Abstract

This AIP specifies the recognized-usage trust and reward system for AntSeed. It
moves ANTS incentives away from raw paid volume and toward a protocol-native
trust signal: usage that is settled through AntSeed channels, attached to a
registered ERC-8004 agent, backed by active seller-pool stake, and shaped by
verification and reputation policies.

The system introduces a mint gate, seller pools keyed by ERC-8004 agent id, a
facts-only usage accounting ledger, and reward controllers for buyers, seller
operators, and seller pool stakers. Usage points are recorded by epoch, buyer,
seller, and agent id. Points are weighted by the seller pool's epoch power,
optionally shaped by policy contracts, and then converted into ANTS rewards
through capped emission buckets.

The proposal also defines the cutover from the legacy emissions and staking
contracts. A legacy escrow funds pre-effective emission epochs from a fixed
pre-minted pot, while the new emissions gate refuses pre-effective epochs and
enforces per-bucket and per-epoch mint caps for all future rewards. The result
is a system where the reward supply, epoch boundaries, bucket budgets, and
historical accounting are defined by auditable on-chain rules.

## Motivation

AntSeed needs rewards to express trust and reputation, not just raw volume. A
network can buy volume from itself; it cannot as easily fake a durable,
stake-backed, agent-level reputation history when accounting is tied to settled
channels, ERC-8004 identity, pool power, and capped reward budgets.

The previous emissions surface did not encode enough information to distinguish
high-trust usage from raw paid activity. Legacy rewards were not linked
on-chain to which buyer used which agent, whether the agent had meaningful
stake behind it, whether a usage record passed verification, or how much of an
epoch's emission any one account could extract.

Raw-volume incentives create three problems:

- they reward payment throughput even when the throughput is low-trust or
  self-dealing;
- they make reputation hard to compare because usage, stake, identity, and
  reward claims live in separate surfaces;
- they leave the core supply and accounting constraints under-specified at the
  protocol layer.

Recognized usage ties ANTS emissions to three observable signals:

- settled USDC-denominated channel usage;
- active ANTS stake in seller pools for ERC-8004 agent ids;
- reward-recipient identity derived from ERC-8004 ownership, AntSeed operator
  mappings, and optional verification and reputation policies.

This AIP moves the trust model into contracts. It specifies the minting rules,
epoch finality, reward caps, legacy cutover, and historical stake power while
preserving policy hooks for verification and abuse resistance. It also keeps
legacy claims and deployed channel contracts working during migration.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

### Epochs and Emission Schedule

The recognized-usage stack MUST use the canonical ANTS emission schedule:

- `GENESIS = 1775728461`
- `EPOCH_DURATION = 7 days`
- `HALVING_INTERVAL = 104 epochs`
- `INITIAL_EMISSION = 5,000,000 ANTS`

For epoch `e`, the scheduled emission is:

```text
epochEmission(e) = INITIAL_EMISSION >> floor(e / HALVING_INTERVAL)
```

An emissions gate MUST expose `currentEpoch()` as
`floor((block.timestamp - GENESIS) / EPOCH_DURATION)`, returning `0` when the
timestamp is at or before genesis.

The gate MUST set `effectiveEpoch` at construction to the next epoch after the
construction epoch. Bucket mints for epochs before `effectiveEpoch` MUST
revert.

### Trust and Reputation Model

Recognized usage MUST NOT be treated as raw volume alone. A usage record is
recognized only when it is recorded by an authorized settlement path and can be
attached to a seller agent id with sufficient seller-pool power for the
accounting epoch.

The recognized-usage stack MUST combine four inputs:

- payment settlement: usage comes from AntSeed channel settlement, not from a
  standalone self-reported counter;
- identity: seller-side usage is attributed to an ERC-8004 agent id;
- economic backing: usage is weighted by the agent pool's epoch power and
  skipped below `minimumAccountedPoolPower`;
- policy shaping: points and pool weight MAY be adjusted by verification,
  reputation, or abuse-resistance policies.

Implementations SHOULD expose recognized usage as a reputation primitive for
agents, buyers, sellers, and pools. Reward distribution is one consumer of that
primitive, but the accounting ledger is also the protocol's durable record of
which agents served recognized demand.

The base emission schedule, finalized epoch boundaries, pre-effective cutoff,
per-bucket mint caps, and frozen per-epoch reward budgets MUST be enforced
on-chain. Policy contracts MAY influence points and weights, but they MUST NOT
increase an epoch beyond the gate's global schedule or a controller beyond its
bucket budget.

### Emissions Gate

The emissions gate is the canonical ANTS mint authority for the recognized
usage era. It MUST enforce:

- a global per-epoch cap equal to `epochEmission(epoch)`;
- one budget per `minterId`, expressed as a share of the epoch emission;
- no minting for in-progress or future epochs;
- no bucket minting before the legacy escrow is funded;
- no bucket minting before `effectiveEpoch`;
- no recipient equal to the zero address.

Minter ids MUST be `bytes32` identifiers. A minter configuration contains:

```solidity
struct Minter {
    address controller;
    uint32 shareBps;
    bool editable;
}
```

The gate MUST use `SHARE_DENOMINATOR = 100000`. Minter shares MUST sum to at
most `100000`.

Share changes MUST take effect from the next epoch, including first-time minter
adds and minter removals. Controller rotation MAY take effect immediately. This
ensures every epoch uses the share set finalized by the end of the previous
epoch and prevents same-epoch share changes from over-allocating the schedule.
After the gate is fully configured, ownership SHOULD be renounced or transferred
to the governance mechanism responsible for protocol changes. The gate MUST
refuse ownership renunciation until the minter shares sum to 100%, deposits are
configured, and the legacy escrow has been funded.

The initial locked minters are:

- contributors bucket: `keccak256("antseed.emissions.team.v1")`
- reserve bucket: `keccak256("antseed.emissions.reserve.v1")`

The recognized-usage deployment configures the following additional minters:

- verification bucket: `keccak256("antseed.emissions.verification.v1")`
- seller pool staker bucket: `keccak256("antseed.emissions.seller-pools.v1")`
- buyer and seller-operator usage bucket:
  `keccak256("antseed.emissions.usage.v1")`

The deployment SHOULD use these default shares:

- contributors: 15%
- reserve: 15%
- verification: 10%
- seller pool stakers: up to 40%
- direct buyer and seller-operator usage: up to 20%

The seller pool staker and direct usage controllers MAY dynamically allocate
less than their maximum bucket budgets for an epoch. Unallocated bucket budget
MUST be settleable through the gate remainder path.

The gate remainder path MUST route the first 30% of total epoch emission
claimed as remainders to the dead address and MUST route any remaining
remainder to the current reserve minter controller. The reserve minter
controller is initially the registry `protocolReserve` and MAY be rotated with
`setMinterController(RESERVE_MINTER_ID, newReserve)`.

### Legacy Emissions Escrow

A legacy emissions escrow MUST be funded once before recognized-usage bucket
mints begin. The escrow amount MUST equal:

```text
max(0, cumulativeEmissionThrough(effectiveEpoch) - ANTS.totalSupply())
```

After funding, the gate MUST refuse all pre-effective epochs. The legacy
emissions contract MAY be pointed at the escrow through a registry facade whose
`antsToken()` returns the escrow itself. The escrow MUST answer the legacy
`mint(recipient, amount)` call by transferring already-minted ANTS from the
escrow pot and MUST only accept that call from the legacy emissions contract.

The escrow owner MAY sweep any remaining escrow balance after legacy claim
activity has wound down. Sweeping before legacy claims are complete can strand
valid legacy claimants and SHOULD NOT be done.

### Seller Pools

Seller pools lock ANTS stake and MUST key pools by ERC-8004 agent id, not by
seller address. A pool exists for an epoch when that agent id has active stake
in the epoch.

Each stake position MUST be represented as an ERC-721 receipt, `lANTS`, with:

```solidity
struct Position {
    address owner;
    uint256 agentId;
    uint256 amount;
    uint256 weightAmount;
    uint64 stakeStartEpoch;
    uint64 stakeEndEpoch;
    uint64 closedAtEpoch;
    bool withdrawn;
}
```

Seller pools MUST support:

- `stake(agentId, amount, stakeEpochs)`
- `stakeFor(staker, agentId, amount, stakeEpochs)`
- `moveStake(positionId, toAgentId)`
- `moveStakes(positionIds, toAgentId)`
- `extendLock(positionId, additionalEpochs)`
- `enableMaxLock(positionId)`
- `disableMaxLock(positionId)`
- `withdrawStake(positionId)`
- `withdrawStakes(positionIds)`
- `stakeMintedReward(staker, sourcePositionId, amount, stakeEpochs)`

New stake and restaked reward positions MUST activate after
`stakeActivationDelay`. Moves and early withdrawals MUST affect future epochs
only, preserving current-epoch power. A moved position MUST preserve principal
but MAY reduce future reward weight through a configured move penalty.

Normal position power SHOULD decay across the locked interval. Max-locked
positions MUST hold maximum-duration power until disabled. Disabling max lock
MUST start a fresh maximum-duration countdown before ordinary withdrawal unless
the position exits early with the configured slash.

Seller pools MUST expose historical pool and position power views sufficient
for usage accounting and reward indexing, including pool power at epoch,
position weight at epoch, total power at epoch, active stake by pool, and active
stake by staker.

Seller pools MUST reject staking into unregistered seller agent ids.

### Seller Registry Adapter

A seller registry adapter MUST preserve the interface that deployed
`AntseedChannels` expects from `registry.staking()`:

- `isStakedAboveMin(address seller)`
- `getAgentId(address seller)`
- `getStake(address seller)`

New seller registration MUST bind a seller address to an ERC-8004 agent id and
MUST require the caller to own that agent id in the ERC-8004 identity registry.
If an agent changes hands, the new owner MAY register it and supersede the
previous seller binding.

Seller eligibility MUST require an agent id and an active seller pool above the
configured minimum stake. During migration, the adapter MAY preserve a
temporary owner-controlled fallback to the legacy USDC staking contract so that
existing sellers remain channel-eligible until ANTS seller pools are seeded.

The adapter MUST NOT lock or hold stake. Legacy `stakeFor` and `unstake`
entrypoints MUST be unsupported on the adapter.

### Usage Accounting

Usage accounting records recognized usage facts by epoch, buyer, seller, and
agent id. It MUST accept usage only from authorized usage recorders. The
initial recorder SHOULD be the deployed `AntseedChannels` contract.

Usage accounting is the reputation ledger for recognized usage. It MUST record
facts separately from rewards so that reward policy can evolve without
rewriting historical usage, and so that already-finalized epochs remain stable.

The accounting contract MUST support the legacy two-call settlement sequence:

```solidity
accrueSellerPoints(address seller, uint256 pointsDelta)
accrueBuyerPoints(address buyer, uint256 pointsDelta)
```

It SHOULD also support the structured one-call sequence:

```solidity
accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta)
```

The legacy two-call path MUST pair the pending seller with the next buyer
accrual. New implementations SHOULD use the structured one-call sequence when
available.

Accrual entrypoints are called from the payment settlement path. They MUST NOT
revert because of pausing or external policy failures. If accounting is paused,
the accrual MUST be skipped. If a points policy or pool weight policy reverts,
the accrual MUST be skipped.

For each accepted usage record, the accounting contract MUST:

1. Resolve the seller's current agent id from seller pools.
2. Read the agent pool power for the accounting epoch.
3. Skip the record if pool power is below `minimumAccountedPoolPower`.
4. Apply the pool weight policy, or use linear weight when no policy is set.
5. Apply the points policy, or use raw points for both buyer and seller when no
   policy is set.
6. Record buyer points, seller points, buyer weighted points, seller weighted
   points, and pool points for the epoch.

Usage settled before `effectiveEpoch` during cutover MUST be recorded under
`effectiveEpoch` so that it remains claimable through the gate.

Buyer rewards MUST be weighted by the pool power of the seller pool that served
the buyer. Seller-operator rewards MUST use the seller's weighted points.
Seller-pool staker rewards MUST use the pool's weighted seller points.

### Direct Buyer and Seller-Operator Rewards

The direct usage reward controller manages one emissions gate bucket and MUST
split its live epoch allocation between:

- buyer rewards;
- seller-operator rewards.

Each side SHOULD use a dynamic share curve based on epoch usage volume. The
default configuration SHOULD allocate 5% to 10% of total epoch emission to
buyers and 5% to 10% to seller operators, bounded by the controller's gate
bucket.

The controller MUST freeze an epoch's buyer and seller budgets at first claim
or remainder settlement for that epoch. Later configuration changes MUST NOT
resize that finalized epoch's budgets.

Seller-operator rewards MUST be claimable only by the current ERC-8004 owner of
the rewarded agent id. Buyer rewards MUST NOT pay the buyer hot wallet. They
MUST pay the buyer's AntSeed deposits operator. If no operator is available,
the claim MUST revert without marking the reward claimed.

Each buyer or agent reward MUST be capped at 5% of that side's frozen epoch
budget. Any gross reward above that cap MUST be routed to the emissions
reserve.

The controller MUST support claiming rewards directly and staking claimed
rewards into a seller pool.

### Seller Pool Staker Rewards

The seller-pool rewards controller manages a separate emissions gate bucket for
stakers. It MUST distribute each epoch's staker budget across agent pools by
weighted pool usage:

```text
poolReward = stakerBudget(epoch)
           * poolWeightedPoints(epoch, agentId)
           / totalWeightedPoolPoints(epoch)
```

Within an agent pool, stakers MUST receive rewards pro rata by position weight
for the indexed epoch range. The controller SHOULD index pool rewards lazily so
claiming a position does not require looping over every historical stake or
pool position.

The default dynamic staker budget SHOULD range from 2% to 40% of total epoch
emission based on active ANTS stake, bounded by the controller's gate bucket.
An epoch's staker budget MUST be frozen at first settlement use. Later
configuration changes MUST NOT resize that finalized epoch's budget.

Staker rewards MUST support direct claim and restaking. Restaking MUST create a
new seller-pool position through `stakeMintedReward`.

When an epoch has no weighted pool usage, the controller MUST treat the entire
bucket budget as unallocated for remainder settlement.

### Remainders and Reserve Routing

Reward controllers MUST expose a way to settle unallocated epoch budget. Once
settled, an epoch's remainder MUST NOT be settled again by the same
controller.

Controller-level reward caps and unallocated budget MUST route through the
reserve minter controller. The emissions gate MUST enforce the global burn cap
for remainders before routing the rest to that reserve.

### Ownership and Cutover

Recognized-usage deployment MUST configure all minters before moving ANTS mint
authority to the emissions gate. After mint authority moves, the legacy escrow
MUST be funded and the legacy emissions contract MUST be pointed at the escrow
before bucket mints are allowed.

The deployed registry SHOULD then point emissions/staking to the
recognized-usage accounting and seller registry adapter. The deployer or owner
MUST transfer ownership of the gate and new contracts to the intended
governance or operations owner. The gate MUST NOT be renounced until:

- minter shares sum to 100%;
- deposits are configured;
- the legacy escrow has been funded.

After these conditions are met, immutable or finalized state SHOULD include the
emission curve, pre-effective cutoff, funded legacy backlog, historical usage
records, historical pool power, and frozen epoch budgets. Mutable policy
surfaces SHOULD only affect future or not-yet-finalized reward outcomes.

## Rationale

The core design change is from volume accounting to trust accounting. Raw
volume is a weak reward signal because it treats every settled unit as equally
valuable. Recognized usage treats settled volume as necessary but not
sufficient: it must be attached to an agent, backed by stake, weighted by pool
power, and bounded by reward caps.

Agent-id keyed pools make trust follow the ERC-8004 identity that buyers are
using, not an arbitrary seller wallet. This matters when an agent is sold or
operated through delegated wallets. Reward recipients can be derived from
ERC-8004 ownership and AntSeed operator mappings while historical pool stake
remains attached to the agent.

The system separates facts from incentives. Usage accounting records settled
facts and weighted points. Reward controllers convert those facts into ANTS
under capped budgets. This keeps channel settlement resilient: policy failures
can skip emissions credit without blocking USDC settlement or seller payouts.

The emissions gate centralizes mint authority while allowing specialized reward
controllers to evolve behind explicit minter ids. The schedule, bucket ceilings,
pre-effective cutoff, and finalized epoch budgets are enforced by contracts,
while policy hooks are limited to shaping future points and weights inside
those caps. Share checkpoints taking effect next epoch avoid same-epoch budget
races and preserve already-earned claims.

The legacy escrow allows the cutover to conserve total supply. Pre-effective
epochs are funded once from a fixed pot and future epochs are claimed through
the gate. That avoids having two mint authorities over the same schedule.

Buyer rewards pay operators rather than hot wallets because buyer wallets are
used for request authorization and payments, not necessarily treasury custody.
This reduces key-handling risk and aligns rewards with the account operator.

The design does not attempt to make reputation fully immutable from day one.
Instead, it finalizes the parts that protect supply and historical accounting
while leaving explicit, auditable policy surfaces for verification and abuse
resistance.

## Backwards Compatibility

This proposal is a contracts-layer migration and is not backwards compatible
with the old emissions and staking address-book semantics. Existing deployed
channels continue to call `registry.emissions()` and `registry.staking()`, but
those pointers resolve to adapters after cutover.

Legacy seller staking remains available only as a temporary eligibility
fallback. New ANTS staking MUST occur through seller pools. Legacy `stakeFor`
and `unstake` calls against the staking adapter revert.

Legacy emissions claims for pre-effective epochs are paid through the escrow,
not through new token minting. Operators may need to temporarily point the
registry back to legacy emissions for the in-flight cutover epoch when deployed
delegation contracts require that path.

## Test Cases

A conforming implementation MUST include tests for:

- emission schedule halving and cumulative emission accounting;
- per-minter and global per-epoch mint caps;
- next-epoch minter share checkpointing;
- refusal of pre-effective and non-finalized epoch claims;
- one-time legacy escrow funding and pre-effective epoch isolation;
- inability for policy contracts to exceed gate or bucket budgets;
- seller pool stake activation, move, max lock, unlock, withdrawal, and slash
  behavior;
- seller registry ownership binding, agent handover, and legacy eligibility
  fallback;
- usage accounting through both the legacy two-call path and structured
  one-call path;
- skipped accruals when accounting is paused or policies fail;
- buyer, seller-operator, and staker reward budget freezing;
- per-account and per-agent direct reward caps;
- buyer rewards refusing to pay buyer hot wallets;
- staker reward indexing and reward conservation;
- remainder settlement, reserve routing, and duplicate-settlement rejection.

The reference implementation includes unit, regression, gas, and fuzz tests for
these invariants.

## Reference Implementation

Reference implementation: https://github.com/AntSeed/antseed/pull/632

Primary contracts:

- `AntseedEmissionsGate`
- `AntseedLegacyEmissionsEscrow`
- `AntseedUsageAccounting`
- `AntseedUsageRewards`
- `AntseedSellerPoolsRewards`
- `AntseedSellerPools`
- `AntseedSellerRegistry`

## Security Considerations

The main security concern is reward attribution integrity. Recognized usage
must be tied to settled channel activity, the correct ERC-8004 agent id, and
the pool power active for the accounting epoch. Implementations MUST preserve
historical usage and pool-power records so later stake moves, ownership
changes, or policy updates cannot rewrite prior reward eligibility.

Usage accounting is called from the payment settlement path. Any revert in
non-essential accounting logic can block USDC settlement and seller payouts, so
paused accounting and policy failures skip emissions credit rather than
reverting. The tradeoff is that misconfigured policies can cause lost rewards
for affected usage until fixed, but cannot seize funds or block payments.

Reward extraction risks include wash trading, Sybil buyer accounts, seller
self-dealing, and concentrated pool stake. Raw-volume rewards amplify these
risks because an attacker can manufacture volume and convert it directly into
emissions. This proposal mitigates these risks with pool-power weighting,
minimum pool power, policy hooks, per-account and per-agent reward caps, dynamic
budgets, and remainder routing. It does not make wash trading impossible.
Production deployments SHOULD use points and pool weight policies informed by
verification, reputation, and abuse monitoring.

Buyer rewards never pay the buyer hot wallet. They pay the configured deposits
operator and revert if no operator is available. This protects request-signing
keys from becoming reward custody keys but creates an operational requirement
to configure operators before claiming.

Seller-pool stake is slashable and time-locked. Early withdrawal and max-lock
disable behavior MUST be carefully surfaced to users because positions can lose
principal or remain locked longer than expected. Contracts MUST preserve
historical epoch power when positions move, extend, or unlock so old reward
claims cannot be rewritten.

The legacy escrow can strand valid legacy claims if swept too early. Operators
SHOULD sweep only after a documented wind-down period and after monitoring
legacy claim activity.

The system depends on ERC-8004 agent ownership for seller reward recipients and
seller registration. Agent transfers can change who is entitled to future
claims. Implementations MUST handle stale seller bindings as no-ops or
ineligible states rather than allowing old sellers to claim rewards for agents
they no longer own.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).
