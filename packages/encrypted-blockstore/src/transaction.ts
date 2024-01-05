import { MemoryBlockstore } from '@alanshaw/pail/block'
import {
  AnyBlock,
  AnyLink,
  CarMakeable,
  FireproofOptions,
  TransactionOpts,
  TransactionMeta as TM
} from './types'

import { Loader } from './loader'
import { CID } from 'multiformats'

export type BlockFetcher = { get: (link: AnyLink) => Promise<AnyBlock | undefined> }

export type TransactionMeta = TM

export class CarTransaction extends MemoryBlockstore implements CarMakeable {
  parent: EncryptedBlockstore
  constructor(parent: EncryptedBlockstore) {
    super()
    parent.transactions.add(this)
    this.parent = parent
  }

  async get(cid: AnyLink): Promise<AnyBlock | undefined> {
    return this.parent.get(cid)
  }

  async superGet(cid: AnyLink): Promise<AnyBlock | undefined> {
    return super.get(cid)
  }
}

export class EncryptedBlockstore implements BlockFetcher {
  ready: Promise<void>
  name: string | null = null

  loader: Loader | null = null
  opts: FireproofOptions = {}
  tOpts: TransactionOpts

  transactions: Set<CarTransaction> = new Set()

  constructor(name: string | null, tOpts: TransactionOpts, opts?: FireproofOptions) {
    this.opts = opts || this.opts
    this.tOpts = tOpts
    if (name) {
      this.name = name
      this.loader = new Loader(name, this.tOpts, this.opts)
      this.ready = this.loader.ready
    } else {
      this.ready = Promise.resolve()
    }
  }

  async transaction(
    fn: (t: CarTransaction) => Promise<TransactionMeta>,
    opts = { noLoader: false }
  ): Promise<TransactionMeta> {
    const t = new CarTransaction(this)
    const done: TransactionMeta = await fn(t)
    if (this.loader) {
      const car = await this.loader.commit(t, done, opts)
      if (car) return { ...done, car }
      throw new Error('failed to commit car')
    }
    return done
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async put() {
    throw new Error('use a transaction to put')
  }

  async get(cid: AnyLink): Promise<AnyBlock | undefined> {
    if (!cid) throw new Error('required cid')
    for (const f of this.transactions) {
      const v = await f.superGet(cid)
      if (v) return v
    }
    if (!this.loader) return
    return await this.loader.getBlock(cid)
  }

  async getFile(car: AnyLink, cid: AnyLink, isPublic = false) {
    await this.ready
    if (!this.loader) throw new Error('loader required to get file')
    const reader = await this.loader.loadFileCar(car, isPublic)
    const block = await reader.get(cid as CID)
    if (!block) throw new Error(`Missing block ${cid.toString()}`)
    return block.bytes
  }

  async compact(compactFn: CompactFn) {
    await this.ready
    if (!this.loader) throw new Error('loader required to compact')
    if (this.loader.carLog.length < 2) return
    const blockLog = new CompactionFetcher(this)
    const meta = await compactFn(blockLog)
    const did = await this.loader!.commit(blockLog.loggedBlocks, meta, {
      compact: true,
      noLoader: true
    })
  }

  async *entries(): AsyncIterableIterator<AnyBlock> {
    const seen: Set<string> = new Set()
    for (const t of this.transactions) {
      for await (const blk of t.entries()) {
        if (seen.has(blk.cid.toString())) continue
        seen.add(blk.cid.toString())
        yield blk
      }
    }
  }
}

export type CompactFn = (blocks: CompactionFetcher) => Promise<TransactionMeta>

export class CompactionFetcher implements BlockFetcher {
  blocks: EncryptedBlockstore
  loader: Loader | null = null
  loggedBlocks: CarTransaction

  constructor(blocks: EncryptedBlockstore) {
    this.blocks = blocks
    this.loader = blocks.loader
    this.loggedBlocks = new CarTransaction(blocks)
  }

  async get(cid: AnyLink) {
    const block = await this.blocks.get(cid)
    if (block) this.loggedBlocks.putSync(cid, block.bytes)
    return block
  }
}