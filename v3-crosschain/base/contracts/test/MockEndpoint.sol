// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Origin, ILayerZeroReceiver} from "../lz/LzTypes.sol";

/// @notice Test-only impersonation of the LayerZero V2 endpoint, driving a
///         receiver exactly the way the real endpoint does for a non-compose
///         delivery: `allowInitializePath` first (revert if false), then
///         `lzReceive` with `msg.sender == address(this)`.
/// @dev    `receiver` is settable so tests can break the deploy-time circular
///         dependency (the receiver is constructed with this endpoint's address).
contract MockEndpoint {
    address public receiver;

    constructor(address _receiver) {
        receiver = _receiver;
    }

    function setReceiver(address _receiver) external {
        receiver = _receiver;
    }

    function deliver(uint32 srcEid, bytes32 sender, bytes calldata payload) external {
        ILayerZeroReceiver recv = ILayerZeroReceiver(receiver);

        bool ok = recv.allowInitializePath(Origin(srcEid, sender, 0));
        require(ok, "MockEndpoint: allowInitializePath=false");

        recv.lzReceive(Origin(srcEid, sender, 0), bytes32(0), payload, address(0), "");
    }

    /// @dev Like `deliver` but skips `allowInitializePath`, so tests can exercise
    ///      the receiver's own `lzReceive` forwarder check on an already-open path.
    function deliverForce(uint32 srcEid, bytes32 sender, bytes calldata payload) external {
        ILayerZeroReceiver(receiver).lzReceive(
            Origin(srcEid, sender, 0),
            bytes32(0),
            payload,
            address(0),
            ""
        );
    }
}
