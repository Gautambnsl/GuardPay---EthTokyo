// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceToken} from "../src/InvoiceToken.sol";

contract InvoiceTokenTest is Test {
    InvoiceToken token;
    address supplier = makeAddr("supplier");
    address payer = makeAddr("payerAgent");
    address payout = makeAddr("payout");

    function setUp() public {
        token = new InvoiceToken();
    }

    function _issue() internal returns (uint256) {
        vm.prank(supplier);
        return token.issue(payer, payout, 50_000, uint64(block.timestamp + 7 days));
    }

    function test_SupplierIssuesAndHoldsNft() public {
        vm.expectEmit(true, true, true, true);
        emit InvoiceToken.InvoiceIssued(1, supplier, payer, payout, 50_000, uint64(block.timestamp + 7 days));
        uint256 id = _issue();
        assertEq(token.ownerOf(id), supplier);
        InvoiceToken.Invoice memory inv = token.getInvoice(id);
        assertEq(inv.issuer, supplier);
        assertEq(inv.payer, payer);
        assertEq(inv.payTo, payout);
        assertFalse(inv.paid);
    }

    function test_PayerMarksPaid() public {
        uint256 id = _issue();
        vm.prank(payer);
        token.markPaid(id, bytes32(uint256(0xabc)));
        InvoiceToken.Invoice memory inv = token.getInvoice(id);
        assertTrue(inv.paid);
        assertEq(inv.paymentRef, bytes32(uint256(0xabc)));
    }

    function test_RevertWhen_NonPayerMarksPaid() public {
        uint256 id = _issue();
        vm.prank(supplier);
        vm.expectRevert(InvoiceToken.NotPayer.selector);
        token.markPaid(id, bytes32(0));
    }

    function test_RevertWhen_PaidTwice() public {
        uint256 id = _issue();
        vm.startPrank(payer);
        token.markPaid(id, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvoiceToken.AlreadyPaid.selector, id));
        token.markPaid(id, bytes32(0));
    }

    function test_RevertWhen_InvalidInvoice() public {
        vm.expectRevert(InvoiceToken.InvalidInvoice.selector);
        token.issue(address(0), payout, 1, 0);
    }

    function test_NftTransferKeepsPayTo() public {
        uint256 id = _issue();
        address financier = makeAddr("financier");
        vm.prank(supplier);
        token.transferFrom(supplier, financier, id);
        assertEq(token.ownerOf(id), financier);
        assertEq(token.getInvoice(id).payTo, payout);
    }
}
