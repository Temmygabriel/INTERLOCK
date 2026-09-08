const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests for BaseDemoVault — the Solidity twin of intelligent-contracts/demo_vault.py.
 *
 * These mirror the Python contract's on-chain semantics on an EVM testnet:
 *   1. genesis health (142% coverage),
 *   2. the intentional `borrow` flaw (no health check -> undercollateralized),
 *   3. the immutable audit log,
 *   4. `trip()` callable ONLY by the configured bridge receiver,
 *   5. `processBridgeMessage` accepting ONLY the narrowly-typed "TRIP" tag,
 *   6. owner-only `resume`.
 *
 * Run (from v3-crosschain/base):
 *   npm install
 *   npx hardhat test
 */
describe("BaseDemoVault", function () {
  let vault;
  let owner;
  let attacker;
  let bridgeReceiver;
  let other;

  // Encode the same narrowly-typed TRIP payload that interlock_v3.py sends via
  // the boilerplate's BridgeSender.emit().send_message(...). The GenLayer side
  // encodes `["TRIP"]` as a `[str]` ABI and strips the method selector, leaving
  // the standard encoding of the string "TRIP" — which is exactly what the
  // default ABI coder produces below.
  function encodeTrip(tag) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["string"], [tag]);
  }

  beforeEach(async function () {
    [owner, attacker, bridgeReceiver, other] = await ethers.getSigners();
    const BaseDemoVault = await ethers.getContractFactory("BaseDemoVault");
    vault = await BaseDemoVault.deploy(owner.address, bridgeReceiver.address);
    await vault.waitForDeployment();
  });

  it("genesis state is healthy (57 collateral / 40 debt => 142% coverage)", async function () {
    expect(await vault.collateral()).to.equal(57n);
    expect(await vault.debt()).to.equal(40n);
    expect(await vault.coverage()).to.equal(142n);
    expect(await vault.paused()).to.equal(false);
    expect(await vault.auditLen()).to.equal(0n);

    const p = await vault.params();
    expect(p.owner_).to.equal(owner.address);
    expect(p.bridgeReceiver_).to.equal(bridgeReceiver.address);
    expect(p.coverage_).to.equal(142n);
    expect(p.paused_).to.equal(false);
  });

  it("borrow has no health check: an undercollateralized borrow is recorded", async function () {
    // Borrow 18 -> debt 58, coverage 57*100/58 = 98% (< 100%): insolvent.
    await expect(vault.connect(attacker).borrow(18n))
      .to.emit(vault, "AuditRecorded")
      .withArgs(1n, "borrow", 18n, 98n);

    expect(await vault.coverage()).to.equal(98n);
    expect(await vault.auditLen()).to.equal(1n);

    const [found, entry] = await vault.getAuditEntry(0n);
    expect(found).to.equal(true);
    expect(entry.op).to.equal("borrow");
    expect(entry.amount).to.equal(18n);
    expect(entry.collateral).to.equal(57n);
    expect(entry.debt).to.equal(58n);
    expect(entry.coverage).to.equal(98n);
  });

  it("out-of-range audit reads return found=false", async function () {
    const [found] = await vault.getAuditEntry(0n);
    expect(found).to.equal(false);
  });

  it("trip() flips paused and records an audit entry", async function () {
    await expect(vault.connect(bridgeReceiver).trip())
      .to.emit(vault, "VaultTripped")
      .withArgs(bridgeReceiver.address);

    expect(await vault.paused()).to.equal(true);
    expect(await vault.auditLen()).to.equal(1n);
    const [found, entry] = await vault.getAuditEntry(0n);
    expect(entry.op).to.equal("bridge_trip");
  });

  it("trip() is idempotent", async function () {
    await vault.connect(bridgeReceiver).trip();
    await vault.connect(bridgeReceiver).trip();
    expect(await vault.paused()).to.equal(true);
    expect(await vault.auditLen()).to.equal(1n); // recorded only once
  });

  it("only the configured bridge receiver may call trip()", async function () {
    await expect(vault.connect(attacker).trip()).to.be.revertedWithCustomError(
      vault,
      "NotBridgeReceiver"
    );
    await expect(vault.connect(other).trip()).to.be.revertedWithCustomError(
      vault,
      "NotBridgeReceiver"
    );
    await expect(vault.connect(owner).trip()).to.be.revertedWithCustomError(
      vault,
      "NotBridgeReceiver"
    );
    expect(await vault.paused()).to.equal(false);
  });

  it("processBridgeMessage with the TRIP tag flips paused", async function () {
    await expect(
      vault
        .connect(bridgeReceiver)
        .processBridgeMessage(40245, owner.address, encodeTrip("TRIP"))
    ).to.emit(vault, "VaultTripped");

    expect(await vault.paused()).to.equal(true);
    expect(await vault.auditLen()).to.equal(1n);
  });

  it("processBridgeMessage rejects non-TRIP payloads", async function () {
    await expect(
      vault.connect(bridgeReceiver).processBridgeMessage(40245, owner.address, encodeTrip("HELLO"))
    ).to.be.revertedWithCustomError(vault, "UnknownMessageType");
    expect(await vault.paused()).to.equal(false);
  });

  it("only the bridge receiver may call processBridgeMessage", async function () {
    await expect(
      vault.connect(other).processBridgeMessage(40245, owner.address, encodeTrip("TRIP"))
    ).to.be.revertedWithCustomError(vault, "NotBridgeReceiver");
    expect(await vault.paused()).to.equal(false);
  });

  it("a paused vault rejects deposit, borrow and withdraw", async function () {
    await vault.connect(bridgeReceiver).trip();
    await expect(vault.connect(attacker).deposit(1n)).to.be.revertedWithCustomError(
      vault,
      "VaultPaused"
    );
    await expect(vault.connect(attacker).borrow(1n)).to.be.revertedWithCustomError(
      vault,
      "VaultPaused"
    );
    await expect(vault.connect(attacker).withdraw(1n)).to.be.revertedWithCustomError(
      vault,
      "VaultPaused"
    );
  });

  it("only the owner may resume", async function () {
    await vault.connect(bridgeReceiver).trip();
    await expect(vault.connect(attacker).resume()).to.be.revertedWithCustomError(
      vault,
      "NotOwner"
    );

    await expect(vault.connect(owner).resume()).to.emit(vault, "GovernanceResumed");
    expect(await vault.paused()).to.equal(false);
    expect(await vault.auditLen()).to.equal(2n); // bridge_trip + governance_resume
  });

  it("withdraw refuses to leave the vault undercollateralized", async function () {
    await vault.connect(attacker).borrow(10n); // debt 50, coverage 57*100/50 = 114%
    // Withdrawing 8 would leave collateral 49 < debt 50 -> revert.
    await expect(vault.connect(attacker).withdraw(8n)).to.be.revertedWithCustomError(
      vault,
      "WouldUndercollateralize"
    );
    // Withdrawing 1 is safe: collateral 56 >= debt 50 -> ok.
    await vault.connect(attacker).withdraw(1n);
    expect(await vault.collateral()).to.equal(56n);
  });

  it("only the owner may change the bridge receiver", async function () {
    await expect(
      vault.connect(attacker).setBridgeReceiver(other.address)
    ).to.be.revertedWithCustomError(vault, "NotOwner");

    await expect(vault.connect(owner).setBridgeReceiver(other.address)).to.emit(
      vault,
      "BridgeReceiverUpdated"
    );
    expect(await vault.bridgeReceiver()).to.equal(other.address);

    // New receiver can now trip; the old one cannot.
    await vault.connect(other).trip();
    expect(await vault.paused()).to.equal(true);
    await expect(vault.connect(bridgeReceiver).trip()).to.be.revertedWithCustomError(
      vault,
      "NotBridgeReceiver"
    );
  });
});
