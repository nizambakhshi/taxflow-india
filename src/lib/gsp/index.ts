import { EwayBillProvider } from './types'
import { mockProvider } from './mock'

// Register real GSP adapters here as they are implemented, e.g.:
//   import { tspProvider } from './tsp'
//   const providers = [mockProvider, tspProvider]
const providers: EwayBillProvider[] = [mockProvider]

export function getProvider(id: string): EwayBillProvider | undefined {
  return providers.find(p => p.id === id)
}

export function listProviders() {
  return providers.map(({ id, name, isMock }) => ({ id, name, isMock }))
}
