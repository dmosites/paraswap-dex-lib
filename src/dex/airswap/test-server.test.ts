import dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import express from 'express';
import {
  createOrderERC20,
  createOrderERC20Signature,
  toAtomicString,
  toDecimalString,
  getCostByPricing,
} from '@airswap/utils';
import { Pricing } from '@airswap/types';
import { SmartTokens } from '../../../tests/constants-e2e';
import { PORT_TEST_SERVER } from '../../constants';
import { AirSwapConfig } from './config';

const smartTokens = SmartTokens[1];
const Levels: Pricing[] = [
  {
    baseToken: smartTokens.DAI.address,
    quoteToken: smartTokens.WETH.address,
    minimum: '0',
    bid: [['10000000000000000000', '1']],
    ask: [['10000000000000000000', '2']],
  },
  {
    baseToken: smartTokens.WETH.address,
    quoteToken: smartTokens.DAI.address,
    minimum: '0',
    bid: [['10000000000000000000', '1']],
    ask: [['10000000000000000000', '2000']],
  },
  {
    baseToken: smartTokens.WETH.address,
    quoteToken: smartTokens.USDC.address,
    minimum: '0',
    bid: [['10000000000000000000', '1800']],
    ask: [['10000000000000000000', '2000']],
  },
  {
    baseToken: smartTokens.USDC.address,
    quoteToken: smartTokens.WETH.address,
    minimum: '0',
    bid: [['1000000000', '1']],
    ask: [['1000000000', '2']],
  },
  {
    baseToken: smartTokens.WETH.address,
    quoteToken: smartTokens.DAI.address,
    minimum: '0',
    bid: [['10000000000000000000', '1800']],
    ask: [['10000000000000000000', '2000']],
  },
  {
    baseToken: smartTokens.DAI.address,
    quoteToken: smartTokens.WETH.address,
    minimum: '0',
    bid: [['10000000000000000000', '1']],
    ask: [['10000000000000000000', '2']],
  },
];

const EXPIRY = 100000;
const PROTOCOL_FEE = 7;

export function result(id: string, result: any) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function error(id: string, code: any, message: any) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

export const startTestServer = (account: ethers.Wallet) => {
  const app = express();
  app.use(express.json({ strict: false }));
  app.post('/', async (req, res) => {
    const id = req.body.id;
    const method = req.body.method;
    const params = req.body.params;
    let response;

    if (method === 'getAllPricingERC20') {
      response = result(id, Levels);
    } else if (
      method === 'getSignerSideOrderERC20' ||
      method === 'getSenderSideOrderERC20'
    ) {
      let { signerToken, senderWallet, senderToken } = params;

      const signerDecimals = 6;
      const senderDecimals = 6;
      let signerAmount;
      let senderAmount;

      try {
        switch (method) {
          case 'getSignerSideOrderERC20':
            senderAmount = toDecimalString(params.senderAmount, senderDecimals);
            signerAmount = getCostByPricing(
              'buy',
              senderAmount,
              senderToken,
              signerToken,
              Levels,
            );
            break;
          case 'getSenderSideOrderERC20':
            signerAmount = toDecimalString(params.signerAmount, signerDecimals);
            senderAmount = getCostByPricing(
              'sell',
              signerAmount,
              signerToken,
              senderToken,
              Levels,
            );
            break;
        }

        if (signerAmount && senderAmount) {
          const order = createOrderERC20({
            nonce: String(Date.now()),
            expiry: String(Math.floor(Date.now() / 1000) + Number(EXPIRY)),
            protocolFee: String(PROTOCOL_FEE),
            signerWallet: account.address,
            signerToken,
            signerAmount: toAtomicString(signerAmount, signerDecimals),
            senderWallet,
            senderToken,
            senderAmount: toAtomicString(senderAmount, senderDecimals),
          });

          const signature = await createOrderERC20Signature(
            order,
            account.privateKey,
            params.swapContract,
            params.chainId,
            AirSwapConfig.AirSwap[1].domainVersion,
            AirSwapConfig.AirSwap[1].domainName,
          );

          response = result(id, {
            ...order,
            ...signature,
          });
        } else {
          response = error(id, -33601, 'Not serving pair');
        }
      } catch (e: any) {
        response = error(id, -33603, e.message);
      }
    }
    return res.status(200).json(response);
  });

  // Resolve the port **now** (after the test has set process.env.TEST_PORT).
  // Fallback order: explicit env var -> constant (may be undefined) -> 0 (OS-assigned random port).
  const port = process.env.TEST_PORT || PORT_TEST_SERVER || 0;
  const server = app.listen(port);

  function stop() {
    server.close();
  }
  (stop as any).port = (server.address() as any).port as number;
  return stop as (() => void) & { port: number };
};

// ------------------------------------------------------------------
// Dummy test so Jest treats this file as a valid test suite.
// It does NOT affect the maker server logic.
// ------------------------------------------------------------------

describe('AirSwap Dummy Maker Server', () => {
  it('helper file loaded', () => {
    expect(true).toBe(true);
  });
});
