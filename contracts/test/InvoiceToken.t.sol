// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceToken} from "../src/InvoiceToken.sol";

contract InvoiceTokenTest is Test {
    InvoiceToken token;
    address owner = address(this);
    address agent = makeAddr("agent");
    address supplier = makeAddr("supplier");

    function setUp() public {
        token = new InvoiceToken(owner, agent);
    }

    function test_IssueMintsToSupplier() public {
        uint256 id = token.issue(supplier, 50_000, uint64(block.timestamp + 7 days));
        assertEq(id, 1);
        assertEq(token.ownerOf(id), supplier);
        InvoiceToken.Invoice memory inv = token.getInvoice(id);
        assertEq(inv.supplier, supplier);
        assertEq(inv.amount, 50_000);
        assertFalse(inv.paid);
    }

    function test_AgentMarksPaid() public {
        uint256 id = token.issue(supplier, 50_000, uint64(block.timestamp + 7 days));
        vm.prank(agent);
        token.markPaid(id, bytes32(uint256(0xabc)));
        InvoiceToken.Invoice memory inv = token.getInvoice(id);
        assertTrue(inv.paid);
        assertEq(inv.paymentRef, bytes32(uint256(0xabc)));
    }

    function test_RevertWhen_NonAgentMarksPaid() public {
        uint256 id = token.issue(supplier, 50_000, uint64(block.timestamp + 7 days));
        vm.expectRevert(InvoiceToken.NotAgent.selector);
        token.markPaid(id, bytes32(0));
    }

    function test_RevertWhen_PaidTwice() public {
        uint256 id = token.issue(supplier, 50_000, uint64(block.timestamp + 7 days));
        vm.startPrank(agent);
        token.markPaid(id, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvoiceToken.AlreadyPaid.selector, id));
        token.markPaid(id, bytes32(0));
    }

    function test_RevertWhen_NonOwnerIssues() public {
        vm.prank(supplier);
        vm.expectRevert();
        token.issue(supplier, 1, 0);
    }
}
