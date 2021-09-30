import { parseUnits } from '@ethersproject/units';
import { TransactionResponse, Web3Provider } from '@ethersproject/providers';
import { MerkleRedeem__factory } from '@balancer-labs/typechain';
import { toWei, soliditySha3 } from 'web3-utils';
import axios from 'axios';

import { Network, networkId } from '@/composables/useNetwork';

import { Claim } from '@/types';

import { ipfsService } from '../ipfs/ipfs.service';
import { call, sendTransaction } from '@/lib/utils/balancer/web3';
import { bnum } from '@/lib/utils';
import { loadTree } from '@/lib/utils/merkle';
import configs from '@/lib/config';
import { TOKENS } from '@/constants/tokens';

import { coingeckoService } from '../coingecko/coingecko.service';

import MultiTokenClaim from './MultiTokenClaim.json';
import { flatten } from 'lodash';
import { getAddress } from '@ethersproject/address';

type Snapshot = Record<number, string>;

type TokenClaimInfo = {
  label: string;
  rewarder: string;
  token: string;
  manifest: string;
};

function getTokenClaimsInfo() {
  const tokenClaims = MultiTokenClaim[networkId.value];
  if (tokenClaims != null) {
    return (tokenClaims as TokenClaimInfo[]).map(tokenClaim => ({
      ...tokenClaim,
      token: getAddress(tokenClaim.token)
    }));
  }

  return null;
}

export async function getSnapshot(manifest: string) {
  const response = await axios.get<Snapshot>(manifest);

  return response.data || {};
}

type ClaimStatus = boolean;

export async function getClaimStatus(
  provider: Web3Provider,
  ids: number,
  account: string,
  rewarder: string
): Promise<ClaimStatus[]> {
  return await call(provider, MerkleRedeem__factory.abi, [
    rewarder,
    'claimStatus',
    [account, 1, ids]
  ]);
}

export type Report = Record<string, any>;

export async function getReports(snapshot: Snapshot, weeks: number[]) {
  const reports = await Promise.all<Report>(
    weeks.map(week => ipfsService.get(snapshot[week]))
  );
  return Object.fromEntries(reports.map((report, i) => [weeks[i], report]));
}

export type PendingClaims = {
  claims: Claim[];
  reports: Report;
  tokenClaimInfo: TokenClaimInfo;
  availableToClaim: string;
};

export type PendingClaimsMap = Record<string, PendingClaims>;

export async function getPendingClaims(
  provider: Web3Provider,
  account: string
): Promise<PendingClaimsMap | null> {
  const tokenClaimsInfo = getTokenClaimsInfo();
  if (tokenClaimsInfo != null) {
    const pendingClaimsMap: PendingClaimsMap = {};

    for (const tokenClaimInfo of tokenClaimsInfo) {
      const snapshot = await getSnapshot(tokenClaimInfo.manifest);

      const claimStatus = await getClaimStatus(
        provider,
        Object.keys(snapshot).length,
        account,
        tokenClaimInfo.rewarder
      );

      const pendingWeeks = claimStatus
        .map((status, i) => [i + 1, status])
        .filter(([, status]) => !status)
        .map(([i]) => i) as number[];

      const reports = await getReports(snapshot, pendingWeeks);
      const claims = Object.entries(reports)
        .filter((report: Report) => report[1][account])
        .map((report: Report) => {
          return {
            id: report[0],
            amount: report[1][account],
            amountDenorm: parseUnits(report[1][account], 18)
          };
        });

      const availableToClaim = claims
        .map(claim => parseFloat(claim.amount))
        .reduce((total, amount) => total.plus(amount), bnum(0))
        .toString();

      pendingClaimsMap[tokenClaimInfo.token] = {
        claims,
        reports,
        tokenClaimInfo,
        availableToClaim
      };
    }

    return pendingClaimsMap;
  }
  return null;
}

type CurrentRewardsEstimateResponse = {
  success: boolean;
  result: {
    current_timestamp: string;
    'liquidity-providers': Array<{
      snapshot_timestamp: string;
      address: string;
      token_address: string;
      chain_id: number;
      current_estimate: string;
      velocity: string;
      week: number;
    }>;
  };
};

export type CurrentRewardsEstimate = {
  rewards: string;
  velocity: string;
  timestamp: string;
} | null;

export async function getCurrentRewardsEstimate(
  network: Network,
  account: string
): Promise<CurrentRewardsEstimate> {
  try {
    const response = await axios.get<CurrentRewardsEstimateResponse>(
      `https://api.balancer.finance/liquidity-mining/v1/liquidity-provider-multitoken/${account}`
    );
    if (response.data.success) {
      const liquidityProviders = response.data.result[
        'liquidity-providers'
      ].filter(
        incentive =>
          incentive.token_address ==
          coingeckoService.prices
            .addressMapOut(TOKENS.AddressMap[String(network)].BAL)
            .toLowerCase()
      );

      const rewards = liquidityProviders
        .reduce(
          (total, { current_estimate }) => total.plus(current_estimate),
          bnum(0)
        )
        .toString();
      const velocity =
        liquidityProviders
          .find(liquidityProvider => Number(liquidityProvider.velocity) > 0)
          ?.velocity.toString() ?? '0';

      if (Array.isArray(liquidityProviders)) {
        return {
          rewards,
          velocity,
          timestamp: response.data.result.current_timestamp
        };
      }
    }
  } catch (e) {
    console.log('[Claim] Current Rewards Estimate Error', e);
  }
  return null;
}

export async function claimRewards(
  network: Network,
  provider: Web3Provider,
  account: string,
  pendingClaims: PendingClaims[]
): Promise<TransactionResponse> {
  try {
    const allClaims: any = [];

    pendingClaims.forEach(pendingClaim => {
      const reports = pendingClaim.reports;

      const claims = pendingClaim.claims.map(week => {
        const claimBalance = week.amount;
        const merkleTree = loadTree(reports[week.id]);

        const proof = merkleTree.getHexProof(
          soliditySha3(account, toWei(claimBalance))
        );
        return [parseInt(week.id), toWei(claimBalance), proof];
      });

      allClaims.push(claims);
    });

    return sendTransaction(
      provider,
      configs[network].addresses.merkleRedeem,
      MerkleRedeem__factory.abi,
      'claimWeeks',
      [account, flatten(allClaims)]
    );
  } catch (e) {
    console.log('[Claim] Claim Rewards Error:', e);
    return Promise.reject(e);
  }
}
