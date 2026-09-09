// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IGenLayerBridgeReceiver} from "./interfaces/IGenLayerBridgeReceiver.sol";

/// @title BaseDemoVault
/// @notice A Solidity twin of the GenLayer `DemoVault`
///         (`intelligent-contracts/demo_vault.py`), deployed on Base Sepolia as
///         the toy victim of the Interlock v3 cross-chain demo.
///
///         **It is a toy, not Aave.** It protects no real funds and makes no
///         claim to model a real production lending protocol. Like its Python
///         twin it is deliberately small and legible, with ONE intentional
///         flaw: `borrow` has no health / maximum check, so any caller can
///         borrow an amount that leaves the pool insolvent (coverage below
///         100%). That undercollateralized borrow is the "exploit incident"
///         the demo trips on.
///
///         Every state-changing operation appends one immutable entry to the
///         `audit` log (the same pattern as `demo_vault.py`). A GenLayer
///         Interlock reads that log and, on confirmed exploit, sends a bridge
///         message that this contract receives via `processBridgeMessage`.
///
///         The brake is `trip()`, callable ONLY by the configured
///         `bridgeReceiver` — the Base Sepolia BridgeReceiver.sol through which
///         the GenLayer-side TRIP message arrives. Unpausing (`resume`) is
///         reserved for the `owner` (a human governance address) and is never
///         reachable from the bridge path.
///
///         Trust boundary (must be disclosed, not glossed over): the
///         destination chain trusts the relay to faithfully deliver a message
///         that really came from confirmed GenLayer consensus. There is no
///         independent finality proof yet — the model is **trusted-relay, not
///         consensus-authenticated**. Same-chain Interlock never has this
///         problem.
contract BaseDemoVault is IGenLayerBridgeReceiver {
    // ------------------------------------------------------------------ roles
    address public owner;            // human governance: may resume, install bridge receiver
    address public bridgeReceiver;   // the bridge receiver that may trip this vault

    // ---------------------------------------------------------- lending state
    uint256 public collateral;       // total supplied collateral (integer units)
    uint256 public debt;             // total outstanding debt (integer units)

    // ---------------------------------------------------------- working state
    bool public paused;
    uint256 public seq;

    struct AuditEntry {
        uint256 seq;
        string op;
        uint256 amount;
        uint256 collateral;
        uint256 debt;
        uint256 coverage;
        uint256 time; // block.timestamp at record time
    }

    AuditEntry[] public audit;

    // ----------------------------------------------------------------- events
    event AuditRecorded(uint256 indexed seq, string op, uint256 amount, uint256 coverage);
    event VaultTripped(address indexed by);
    event GovernanceResumed(address indexed by);
    event BridgeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

    // ----------------------------------------------------------------- errors
    error NotOwner();
    error NotBridgeReceiver();
    error VaultPaused();
    error ZeroAmount();
    error ZeroAddress();
    error WithdrawExceedsCollateral();
    error WouldUndercollateralize();
    error UnknownMessageType();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyBridgeReceiver() {
        if (msg.sender != bridgeReceiver) revert NotBridgeReceiver();
        _;
    }

    constructor(address _owner, address _bridgeReceiver) {
        if (_owner == address(0) || _bridgeReceiver == address(0)) revert ZeroAddress();
        owner = _owner;
        bridgeReceiver = _bridgeReceiver;
        // Genesis state mirrors demo_vault.py: 57 collateral vs 40 debt => 142% coverage.
        collateral = 57;
        debt = 40;
        paused = false;
        seq = 0;
        // audit starts empty; every operation appends one immutable entry
    }

    // ------------------------------------------------------------------ utils

    function _coveragePct() internal view returns (uint256) {
        // Whole-percent coverage. If there is no debt the pool is fully safe -> 10000.
        if (debt == 0) return 10000;
        return (collateral * 100) / debt;
    }

    function _requireLive() internal view {
        if (paused) revert VaultPaused();
    }

    function _record(string memory op, uint256 amount) internal {
        uint256 next = seq + 1;
        audit.push(
            AuditEntry({
                seq: next,
                op: op,
                amount: amount,
                collateral: collateral,
                debt: debt,
                coverage: _coveragePct(),
                time: block.timestamp
            })
        );
        seq = next;
        emit AuditRecorded(next, op, amount, _coveragePct());
    }

    function _trip() internal {
        if (!paused) {
            paused = true;
            _record("bridge_trip", 0);
            emit VaultTripped(msg.sender);
        }
    }

    // ------------------------------------------------------------ public views

    /// @notice Mirror of `demo_vault.params()`.
    function params()
        external
        view
        returns (
            address owner_,
            address bridgeReceiver_,
            uint256 collateral_,
            uint256 debt_,
            uint256 coverage_,
            bool paused_,
            uint256 audit_len_
        )
    {
        return (owner, bridgeReceiver, collateral, debt, _coveragePct(), paused, seq);
    }

    function coverage() external view returns (uint256) {
        return _coveragePct();
    }

    function auditLen() external view returns (uint256) {
        return seq;
    }

    function getAuditEntry(uint256 index) external view returns (bool found, AuditEntry memory entry) {
        if (index >= audit.length) return (false, entry);
        return (true, audit[index]);
    }

    // ------------------------------------------------------------ public writes

    function deposit(uint256 amount) external {
        _requireLive();
        if (amount == 0) revert ZeroAmount();
        collateral += amount;
        _record("deposit", amount);
    }

    function borrow(uint256 amount) external {
        _requireLive();
        if (amount == 0) revert ZeroAmount();
        // FLAW (intentional): no health / maximum check. A borrower may take out an
        // undercollateralized loan, leaving the pool insolvent. This is the incident
        // the demo reports to Interlock.
        debt += amount;
        _record("borrow", amount);
    }

    function withdraw(uint256 amount) external {
        _requireLive();
        if (amount == 0) revert ZeroAmount();
        if (amount > collateral) revert WithdrawExceedsCollateral();
        uint256 newCollateral = collateral - amount;
        if (debt > 0 && newCollateral < debt) revert WouldUndercollateralize();
        collateral = newCollateral;
        _record("withdraw", amount);
    }

    /// @notice The brake. Only the configured bridge receiver may call this. Idempotent.
    function trip() external onlyBridgeReceiver {
        _trip();
    }

    /// @notice Entry point for bridged GenLayer messages (IGenLayerBridgeReceiver).
    ///         Accepts ONLY the narrowly-typed TRIP tag; any other payload is
    ///         rejected. This is never a generic arbitrary-call primitive.
    function processBridgeMessage(
        uint32,
        address,
        bytes calldata _message
    ) external onlyBridgeReceiver {
        string memory tag = abi.decode(_message, (string));
        if (keccak256(bytes(tag)) != keccak256(bytes("TRIP"))) revert UnknownMessageType();
        _trip();
    }

    function resume() external onlyOwner {
        if (paused) {
            paused = false;
            _record("governance_resume", 0);
            emit GovernanceResumed(msg.sender);
        }
    }

    /// @notice BOOTSTRAP: the protocol owner arms the breaker by installing the
    ///         bridge receiver — the one authority that may trip this vault.
    ///         Owner-only, and only while the vault is live; the swap is itself
    ///         recorded on the audit log. Mirrors `demo_vault.set_guardian`.
    function setBridgeReceiver(address newBridgeReceiver) external onlyOwner {
        if (newBridgeReceiver == address(0)) revert ZeroAddress();
        if (paused) revert VaultPaused();
        address oldReceiver = bridgeReceiver;
        bridgeReceiver = newBridgeReceiver;
        _record("bridge_receiver_update", 0);
        emit BridgeReceiverUpdated(oldReceiver, newBridgeReceiver);
    }
}
