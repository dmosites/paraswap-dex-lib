import { DexConfigMap } from '../../types';
import { mainnets } from '@airswap/utils';
//@ts-ignore
import registryBlocks from '@airswap/registry/deploys-blocks';
import { AirSwapDeployment } from './types';

const AirSwap: any = {};
let length = mainnets.length;
while (length--) {
  AirSwap[mainnets[length]] = {
    swapERC20Address: '0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46',
    registryAddress: '0xe30E9c001dEFb5F0B04fD21662454A2427F4257A',
    registryBlock: registryBlocks[mainnets[length]],
    domainName: 'SWAP_ERC20',
    domainVersion: '5.0',
  };
}

export const AirSwapConfig: DexConfigMap<AirSwapDeployment> = {
  AirSwap,
};
