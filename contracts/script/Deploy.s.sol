// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {InvoiceToken} from "../src/InvoiceToken.sol";

/// Deploys InvoiceToken and issues the four demo invoices.
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, AGENT_PRIVATE_KEY, CLEAN_SUPPLIER_ADDRESS, RISKY_SUPPLIER_ADDRESS
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));
        address clean = vm.envAddress("CLEAN_SUPPLIER_ADDRESS");
        address risky = vm.envAddress("RISKY_SUPPLIER_ADDRESS");
        uint64 due = uint64(block.timestamp + 14 days);

        vm.startBroadcast(deployerKey);
        InvoiceToken token = new InvoiceToken(vm.addr(deployerKey), agent);
        // Amounts in USDC (6 decimals). Must match agent/src/scenarios.ts.
        token.issue(clean, 50_000, due); // #1 $0.05  small, clean   -> PAY
        token.issue(risky, 50_000, due); // #2 $0.05  risky payTo    -> REFUSE
        token.issue(clean, 2_000_000, due); // #3 $2.00  large, clean   -> ESCALATE -> PAY
        token.issue(clean, 2_000_000, due); // #4 $2.00  large, denied  -> NOT PAID
        vm.stopBroadcast();

        console2.log("INVOICE_TOKEN_ADDRESS=%s", address(token));
    }
}
