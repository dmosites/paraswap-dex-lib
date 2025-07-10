import dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import { Network, ContractMethod, SwapSide, MAX_UINT } from '../../constants';
import { generateConfig } from '../../config';
import { newTestE2E } from '../../../tests/utils-e2e';
import {
  Tokens as SmartTokens,
  GENERIC_ADDR1,
} from '../../../tests/constants-e2e';
import { startTestServer } from './test-server.test';
import { AirSwapConfig } from './config';
import { Config } from '../../types';

const PK_KEY = process.env.TEST_PK_KEY;
if (!PK_KEY) {
  throw new Error('Missing TEST_PK_KEY');
}

const testAccount = new ethers.Wallet(PK_KEY!);

jest.setTimeout(1000 * 60 * 3);

describe('AirSwap E2E Mainnet', () => {
  let stopServer: ((() => void) & { port: number }) | null = null;
  let config: Config;

  beforeAll(() => {
    stopServer = startTestServer(testAccount);
    process.env.AIRSWAP_SERVER_URLS_1 = `http://localhost:${stopServer.port}`;
    config = generateConfig(Network.MAINNET);
  });

  const network = Network.MAINNET;
  const smartTokens = SmartTokens[network];

  const srcToken = smartTokens.WETH;
  const destToken = smartTokens.DAI;

  describe('AirSwap', () => {
    const dexKey = 'AirSwap';

    // Token balances/allowances are set inside newTestE2E via Tenderly overrides.

    describe('Simpleswap', () => {
      it('SELL WETH -> DAI', async () => {
        await newTestE2E({
          config,
          srcToken,
          destToken,
          senderAddress: GENERIC_ADDR1,
          thirdPartyAddress: testAccount.address,
          _amount: '10000000000000000000',
          swapSide: SwapSide.SELL,
          dexKeys: dexKey,
          contractMethod: ContractMethod.simpleSwap,
          network: network,
          skipTenderly: true,
        });
      });
    });
  });

  afterAll(() => {
    stopServer?.();
  });
});
