// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IGenLayerBridgeReceiver} from "../boilerplate/smart-contracts/contracts/interfaces/IGenLayerBridgeReceiver.sol";
import {Origin, ILayerZeroReceiver} from "./contracts/lz/LzTypes.sol";

/// @title BaseTripDispatcher
/// @notice Destination-side (Base Sepolia) LayerZero receiver for Interlock v3's
///         GenLayer -> EVM `TRIP` messages.
///
///         WHY IT EXISTS. The Foundation boilerplate ships one `BridgeReceiver.sol`
///         for both directions, but that contract only implements the EVM->GenLayer
///         half: its `lzReceive` decodes a 5-field tuple
///         `(uint32, address, address, bytes, bytes32)` and *stores* the message for
///         the relay to poll. It never calls `processBridgeMessage` on a target, so
///         it cannot be the destination receiver for the GenLayer->EVM direction.
///         This dispatcher fills exactly that gap — it is the address that gets
///         registered on the zkSync Era Sepolia `BridgeForwarder` as
///         `bridgeAddresses[40245]`, so LayerZero delivers the GenLayer-originated
///         payload here.
///
///         WHAT IT DOES. The payload `BridgeSender.py` produces (and the relay
///         forwards unmodified) is a 4-field tuple:
///         `abi.encode(uint32 srcChainId, address srcSender, address localContract, bytes message)`
///         — the exact shape the forwarder's own same-chain (local) branch decodes.
///         This dispatcher decodes that tuple, verifies the sender is the trusted
///         zkSync Era Sepolia forwarder, and forwards `message` to the whitelisted
///         `localContract`'s `processBridgeMessage(srcChainId, srcSender, message)`.
///
///         SAFETY. Two independent checks, both required:
///           1. Only the LayerZero Endpoint can invoke `lzReceive` (msg.sender check).
///           2. The origin sender must be a configured trusted forwarder
///              (`allowInitializePath` / `lzReceive` agree).
///         Plus the payload's `localContract` must be on an owner-managed
///         whitelist, so a compromised relay could not re-point this dispatcher at
///         an arbitrary contract. It forwards only the narrow `message` bytes to a
///         pre-registered target — never an arbitrary call.
///
///         TRUST MODEL (must be disclosed, not glossed over): the destination chain
///         trusts the relay to faithfully deliver a message that really came from
///         confirmed GenLayer consensus. There is NO independent finality proof yet
///         — trusted-relay, NOT consensus-authenticated. Same-chain Interlock never
///         has this problem.
contract BaseTripDispatcher is ILayerZeroReceiver {
    address public immutable endpoint;
    address public owner;

    /// srcEid -> 32-byte trusted forwarder (zkSync Era Sepolia = 40305).
    mapping(uint32 => bytes32) public trustedForwarders;
    /// Whitelisted destination contracts the dispatcher may forward to.
    mapping(address => bool) public trustedTargets;

    event TrustedForwarderSet(uint32 indexed remoteEid, bytes32 indexed remoteForwarder);
    event TrustedTargetSet(address indexed target, bool trusted);
    event TripForwarded(uint32 srcChainId, address srcSender, address targetContract, bytes message);

    error ZeroAddress();
    error NotOwner();
    error OnlyEndpoint();
    error UntrustedForwarder();
    error UntrustedTarget();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _endpoint, address _owner) {
        if (_endpoint == address(0) || _owner == address(0)) revert ZeroAddress();
        endpoint = _endpoint;
        owner = _owner;
    }

    // ---------------------------------------------------------------- owner ops

    /// @notice Hand governance of this dispatcher to a new address.
    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroAddress();
        owner = _newOwner;
    }

    /// @notice Trust a remote forwarder (the zkSync Era Sepolia BridgeForwarder)
    ///         for a given source EID. Mirrors the shipped BridgeReceiver's
    ///         `setTrustedForwarder`.
    function setTrustedForwarder(uint32 _remoteEid, bytes32 _remoteForwarder) external onlyOwner {
        if (_remoteForwarder == bytes32(0)) revert ZeroAddress();
        trustedForwarders[_remoteEid] = _remoteForwarder;
        emit TrustedForwarderSet(_remoteEid, _remoteForwarder);
    }

    /// @notice Whitelist (or de-whitelist) a destination contract the dispatcher
    ///         may forward TRIP messages to. Only BaseDemoVault needs this in v3.
    function setTrustedTarget(address _target, bool _trusted) external onlyOwner {
        if (_target == address(0)) revert ZeroAddress();
        trustedTargets[_target] = _trusted;
        emit TrustedTargetSet(_target, _trusted);
    }

    // ----------------------------------------------------- LayerZero V2 receiver

    /// @notice LayerZero calls this to learn whether a path may be initialized.
    ///         Only the configured forwarder on the given source EID is trusted.
    function allowInitializePath(Origin calldata _origin) external view returns (bool) {
        return trustedForwarders[_origin.srcEid] == _origin.sender;
    }

    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    /// @notice Deliver a GenLayer-originated message. Payload layout is the 4-field
    ///         tuple that `BridgeSender.py` stores (also decoded by the forwarder's
    ///         same-chain branch).
    function lzReceive(
        Origin calldata _origin,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (trustedForwarders[_origin.srcEid] != _origin.sender) revert UntrustedForwarder();

        (uint32 srcChainId, address srcSender, address localContract, bytes memory message) = abi.decode(
            _message,
            (uint32, address, address, bytes)
        );
        if (!trustedTargets[localContract]) revert UntrustedTarget();

        IGenLayerBridgeReceiver(localContract).processBridgeMessage(srcChainId, srcSender, message);
        emit TripForwarded(srcChainId, srcSender, localContract, message);
    }
}
