import dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import { Network, ContractMethod, SwapSide, MAX_UINT } from '../../constants';
import { generateConfig } from '../../config';
import { newTestE2E } from '../../../tests/utils-e2e';
import { SmartTokens, GENERIC_ADDR1 } from '../../../tests/constants-e2e';
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

    srcToken.addBalance(testAccount.address, MAX_UINT);
    srcToken.addAllowance(
      testAccount.address,
      AirSwapConfig.AirSwap[network].swapERC20Address,
      MAX_UINT,
    );

    destToken.addBalance(testAccount.address, MAX_UINT);
    destToken.addAllowance(
      testAccount.address,
      AirSwapConfig.AirSwap[network].swapERC20Address,
      MAX_UINT,
    );

    describe('Simpleswap', () => {
      it('SELL WETH -> DAI', async () => {
        await newTestE2E({
          config,
          srcToken,
          destToken,
          senderAddress: GENERIC_ADDR1,
          thirdPartyAddress: testAccount.address,
          _amount: '10000000000000000',
          swapSide: SwapSide.SELL,
          dexKey: dexKey,
          contractMethod: ContractMethod.simpleSwap,
          network: network,
          sleepMs: 3000,
          skipTenderly: true,
        });
      });
    });
  });

  afterAll(() => {
    stopServer?.();
  });
});
