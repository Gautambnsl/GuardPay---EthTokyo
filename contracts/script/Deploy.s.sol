// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {InvoiceToken} from "../src/InvoiceToken.sol";

/// Deploys InvoiceToken. Invoices are then issued by suppliers (see agent/src/supplier.ts).
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        InvoiceToken token = new InvoiceToken();
        vm.stopBroadcast();
        console2.log("INVOICE_TOKEN_ADDRESS=%s", address(token));
    }
}
