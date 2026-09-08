const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests for BaseTripDispatcher — the Base Sepolia LayerZero receiver that
 * delivers Interlock v3's GenLayer->EVM TRIP messages to BaseDemoVault.
 *
 * The payload layout under test is EXACTLY what the GenLayer side produces:
 *   BridgeSender.py stores abi.encode(61998, sender, Address(target_contract), data)
 *   -> relay reads get_message(hash).data -> forwarder sends it unchanged
 *   -> this dispatcher decodes (uint32 srcChainId, address srcSender, address localContract, bytes message)
 *
 * Run (from v3-crosschain/base):
 *   npm install
 *   npx hardhat test
 */
describe("BaseTripDispatcher", function () {
  let endpoint;      // MockEndpoint (stands in for the LayerZero endpoint on Base Sepolia)
  let dispatcher;    // BaseTripDispatcher
  let vault;         // BaseDemoVault (the toy victim)
  let owner;
  let forwarder;     // stands in for the zkSync Era Sepolia BridgeForwarder
  let attacker;
  let other;

  const ZKSYNC_EID = 40305;
  const GENLAYER_SRC_CHAIN = 61998; // value BridgeSender.py hard-codes as srcChainId

  // Encode the same narrowly-typed TRIP payload that interlock_v3.py sends
  // (abi.encode("TRIP") — [str] ABI, selector stripped).
  function encodeTrip(tag) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["string"], [tag]);
  }

  // Build the 4-field payload BridgeSender.py produces.
  function encodeBridgePayload(srcChainId, srcSender, localContract, message) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "address", "address", "bytes"],
      [srcChainId, srcSender, localContract, message]
    );
  }

  // 32-byte form of an address (LayerZero Origin.sender is bytes32).
  function toBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
  }

  beforeEach(async function () {
    [owner, forwarder, attacker, other] = await ethers.getSigners();

    const BaseDemoVault = await ethers.getContractFactory("BaseDemoVault");
    const BaseTripDispatcher = await ethers.getContractFactory("BaseTripDispatcher");

    // Deploy order breaks the circular endpoint/receiver dependency:
    // endpoint first (dummy), then dispatcher, then point the endpoint at it.
    endpoint = await (await ethers.getContractFactory("MockEndpoint")).deploy(owner.address);
    await endpoint.waitForDeployment();

    dispatcher = await BaseTripDispatcher.deploy(endpoint.target, owner.address);
    await dispatcher.waitForDeployment();

    await endpoint.setReceiver(dispatcher.target); // ensure receiver is set before tests

    // The vault accepts TRIP only from the dispatcher.
    vault = await BaseDemoVault.deploy(owner.address, dispatcher.target);
    await vault.waitForDeployment();
  });

  it("is deployed with the expected owner and endpoint", async function () {
    expect(await dispatcher.owner()).to.equal(owner.address);
    expect(await dispatcher.endpoint()).to.equal(endpoint.target);
  });

  it("rejects a zero endpoint or zero owner at construction", async function () {
    const Factory = await ethers.getContractFactory("BaseTripDispatcher");
    await expect(Factory.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(
      Factory,
      "ZeroAddress"
    );
    await expect(Factory.deploy(endpoint.target, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Factory,
      "ZeroAddress"
    );
  });

  it("only the owner may set the trusted forwarder or a trusted target", async function () {
    await expect(
      dispatcher.connect(attacker).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address))
    ).to.be.revertedWithCustomError(dispatcher, "NotOwner");
    await expect(
      dispatcher.connect(attacker).setTrustedTarget(vault.target, true)
    ).to.be.revertedWithCustomError(dispatcher, "NotOwner");
  });

  it("rejects a zero trusted forwarder", async function () {
    await expect(
      dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(dispatcher, "ZeroAddress");
  });

  it("rejects a zero trusted target", async function () {
    await expect(
      dispatcher.connect(owner).setTrustedTarget(ethers.ZeroAddress, true)
    ).to.be.revertedWithCustomError(dispatcher, "ZeroAddress");
  });

  it("only the owner may transfer ownership, and the new owner takes over", async function () {
    await expect(
      dispatcher.connect(attacker).transferOwnership(other.address)
    ).to.be.revertedWithCustomError(dispatcher, "NotOwner");
    await dispatcher.connect(owner).transferOwnership(other.address);
    expect(await dispatcher.owner()).to.equal(other.address);

    // New owner can configure; old owner can no longer.
    await dispatcher.connect(other).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await expect(
      dispatcher.connect(owner).setTrustedTarget(vault.target, true)
    ).to.be.revertedWithCustomError(dispatcher, "NotOwner");
  });

  it("does not initialize a path from an untrusted forwarder", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    const allow = await dispatcher.allowInitializePath({
      srcEid: ZKSYNC_EID,
      sender: toBytes32(other.address),
      nonce: 0,
    });
    expect(allow).to.equal(false);
  });

  it("initializes the path from the trusted forwarder", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    const allow = await dispatcher.allowInitializePath({
      srcEid: ZKSYNC_EID,
      sender: toBytes32(forwarder.address),
      nonce: 0,
    });
    expect(allow).to.equal(true);
  });

  it("delivers a TRIP end-to-end: mock endpoint -> dispatcher -> BaseDemoVault.trip()", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    // Exactly what BridgeSender.py stores: (61998, srcSender, vault, abi.encode("TRIP")).
    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));

    await expect(endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload))
      .to.emit(dispatcher, "TripForwarded")
      .withArgs(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));

    expect(await vault.paused()).to.equal(true);
    expect(await vault.auditLen()).to.equal(1n);
    const [found, entry] = await vault.getAuditEntry(0n);
    expect(found).to.equal(true);
    expect(entry.op).to.equal("bridge_trip");
  });

  it("delivers from any source EID whose forwarder is configured (multi-forwarder)", async function () {
    // Base Sepolia as a source is contrived but proves the keying is per-EID.
    await dispatcher.connect(owner).setTrustedForwarder(40245, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await endpoint.deliver(40245, toBytes32(forwarder.address), payload);
    expect(await vault.paused()).to.equal(true);
  });

  it("reverts when the origin forwarder is not trusted", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await expect(
      endpoint.deliver(ZKSYNC_EID, toBytes32(other.address), payload) // wrong forwarder
    ).to.be.revertedWith("MockEndpoint: allowInitializePath=false");
    expect(await vault.paused()).to.equal(false);
  });

  it("lzReceive itself rejects an untrusted forwarder even on an open path", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await expect(
      endpoint.deliverForce(ZKSYNC_EID, toBytes32(other.address), payload) // wrong forwarder, bypass path check
    ).to.be.revertedWithCustomError(dispatcher, "UntrustedForwarder");
    expect(await vault.paused()).to.equal(false);
  });

  it("reverts when the payload's localContract is not whitelisted", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    // NOTE: vault NOT whitelisted.

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await expect(
      endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload)
    ).to.be.revertedWithCustomError(dispatcher, "UntrustedTarget");
    expect(await vault.paused()).to.equal(false);
  });

  it("reverts when the forwarded inner message is not the TRIP tag", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("HELLO"));
    await expect(
      endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload)
    ).to.be.revertedWithCustomError(vault, "UnknownMessageType");
    expect(await vault.paused()).to.equal(false);
  });

  it("only the LayerZero endpoint may call lzReceive", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    const iface = new ethers.Interface([
      "function lzReceive((uint32,bytes32,uint64),bytes32,bytes,address,bytes)",
    ]);
    const calldata = iface.encodeFunctionData("lzReceive", [
      { srcEid: ZKSYNC_EID, sender: toBytes32(forwarder.address), nonce: 0 },
      ethers.ZeroHash,
      payload,
      ethers.ZeroAddress,
      "0x",
    ]);

    await expect(
      other.sendTransaction({ to: dispatcher.target, data: calldata, value: 0 })
    ).to.be.revertedWithCustomError(dispatcher, "OnlyEndpoint");
    expect(await vault.paused()).to.equal(false);
  });

  it("a second delivery is idempotent at the vault (trip once, paused stays true)", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload);
    await endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload);

    expect(await vault.paused()).to.equal(true);
    expect(await vault.auditLen()).to.equal(1n); // recorded only once
  });

  it("de-whitelisting a target makes delivery revert", async function () {
    await dispatcher.connect(owner).setTrustedForwarder(ZKSYNC_EID, toBytes32(forwarder.address));
    await dispatcher.connect(owner).setTrustedTarget(vault.target, true);
    await dispatcher.connect(owner).setTrustedTarget(vault.target, false);

    const payload = encodeBridgePayload(GENLAYER_SRC_CHAIN, attacker.address, vault.target, encodeTrip("TRIP"));
    await expect(
      endpoint.deliver(ZKSYNC_EID, toBytes32(forwarder.address), payload)
    ).to.be.revertedWithCustomError(dispatcher, "UntrustedTarget");
    expect(await vault.paused()).to.equal(false);
  });
});
