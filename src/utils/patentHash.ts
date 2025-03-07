import crypto from 'crypto';

/**
 * Implementation of Microsoft's Patent Hash algorithm used by SmartScreen
 * Uses Node.js crypto module for MD5 calculation
 */
export class PatentHash {
  /**
   * Swaps high and low 16 bits of a 32-bit integer
   */
  private static swapHalfWord(value: number): number {
    return (value >>> 16) + (value << 16);
  }
  
  /**
   * First custom hashing function
   */
  private static processBlockA(state: HashState, r: number, c1: number, c2: number, c3: number, c4: number): void {
    state.t = (state.t + state.buffer.getWord(state.index++)) | 0;
    state.t = Math.imul(state.t, r) + Math.imul(PatentHash.swapHalfWord(state.t), c1) | 0;
    state.t = Math.imul(PatentHash.swapHalfWord(state.t), c2) + Math.imul(state.t, c3) | 0;
    state.t = state.t + Math.imul(PatentHash.swapHalfWord(state.t), c4) | 0;
    state.sum = state.sum + state.t | 0;
  }
  
  /**
   * Second custom hashing function
   */
  private static processBlockB(state: HashStateExtended, r: number, c1: number, c2: number, c3: number, c4: number, c5: number): void {
    state.t = (state.t + state.buffer.getWord(state.index++)) | 0;
    state.t = Math.imul(state.t, r);
    state.u = 0 | PatentHash.swapHalfWord(state.t);
    state.t = Math.imul(state.u, c1);
    state.t = Math.imul(PatentHash.swapHalfWord(state.t), c2);
    state.t = Math.imul(PatentHash.swapHalfWord(state.t), c3);
    state.t = Math.imul(PatentHash.swapHalfWord(state.t), c4);
    state.t = state.t + Math.imul(state.u, c5) | 0;
    state.sum = state.sum + state.t | 0;
  }
  
  /**
   * Calculate hash value for input string
   */
  public static hash(input: string): { key: string, hash: string } {
    // Use Node.js crypto for MD5 calculation
    const md5Hash = crypto.createHash('md5').update(input).digest();
    
    // Convert MD5 digest to array of 32-bit integers (4 bytes each)
    const md5Result = [
      md5Hash.readInt32LE(0),
      md5Hash.readInt32LE(4),
      md5Hash.readInt32LE(8),
      md5Hash.readInt32LE(12)
    ];
    
    const buffer = {
      length: (input.length / 4) & -2,
      getWord: (index: number): number => {
        const byteIndex = 4 * index;
        return (
          (input.charCodeAt(byteIndex) << 0) |
          (input.charCodeAt(byteIndex + 1) << 8) |
          (input.charCodeAt(byteIndex + 2) << 16) |
          (input.charCodeAt(byteIndex + 3) << 24)
        );
      }
    };
    
    const finalHash = [0, 0];
    const intermediateHash = [0, 0];
    
    if (this.processFirstHash(buffer, md5Result, intermediateHash)) {
      const secondHash = [0, 0];
      
      if (this.processSecondHash(buffer, md5Result, secondHash)) {
        finalHash[0] = intermediateHash[0] ^ secondHash[0];
        finalHash[1] = intermediateHash[1] ^ secondHash[1];
      }
    }
    
    // Convert result integers to Buffer for base64 encoding
    const resultBuffer = Buffer.alloc(8);
    resultBuffer.writeInt32LE(finalHash[0], 0);
    resultBuffer.writeInt32LE(finalHash[1], 4);
    
    return {
      key: md5Hash.toString('base64'),
      hash: resultBuffer.toString('base64')
    };
  }
  
  /**
   * Process first hash function
   */
  private static processFirstHash(buffer: BufferWrapper, seed: number[], result: number[]): boolean {
    if (buffer.length < 2 || (buffer.length & 1) !== 0) {
      return false;
    }
    
    const r1 = 1 | seed[0];
    const r2 = 1 | seed[1];
    
    const state: HashState = {
      buffer,
      index: 0,
      sum: 0,
      t: 0
    };
    
    while (state.buffer.length - state.index > 1) {
      this.processBlockA(state, r1, 4010109435, 1755016095, 240755605, 3287280279);
      this.processBlockA(state, r2, 3273069531, 3721207567, 984919853, 901586633);
    }
    
    result[0] = state.t;
    result[1] = state.sum;
    return true;
  }
  
  /**
   * Process second hash function
   */
  private static processSecondHash(buffer: BufferWrapper, seed: number[], result: number[]): boolean {
    if (buffer.length < 2 || (buffer.length & 1) !== 0) {
      return false;
    }
    
    const r1 = 1 | seed[0];
    const r2 = 1 | seed[1];
    
    const state: HashStateExtended = {
      buffer,
      index: 0,
      sum: 0,
      t: 0,
      u: 0
    };
    
    while (state.buffer.length - state.index > 1) {
      this.processBlockB(state, r1, 3482890513, 2265471903, 315537773, 629022083, 0);
      this.processBlockB(state, r2, 2725517045, 3548616447, 2090019721, 3215236969, 0);
    }
    
    result[0] = state.t;
    result[1] = state.sum;
    return true;
  }
}

// Type definitions
interface BufferWrapper {
  length: number;
  getWord: (index: number) => number;
}

interface HashState {
  buffer: BufferWrapper;
  index: number;
  sum: number;
  t: number;
}

interface HashStateExtended extends HashState {
  u: number;
}