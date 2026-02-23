/**
 * SFC32 可复现随机数生成器 - 与 Python 实现对齐
 *
 * 用于对齐测试：JS 和 Python 使用相同算法和种子，产生完全一致的 [0,1) 浮点序列。
 */

/**
 * 创建 SFC32 随机数生成器
 * @param {number} seed - 32位种子值
 * @returns {function(): number} 返回 [0, 1) 范围浮点数的函数
 */
export function createSFC32(seed) {
  let a = seed >>> 0;
  let b = seed >>> 0;
  let c = seed >>> 0;
  let counter = 1;

  // 预热（丢弃前 15 个值以充分混合状态）
  for (let i = 0; i < 15; i++) {
    const result = (a + b + counter) >>> 0;
    counter = (counter + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + ((c << 3) >>> 0)) >>> 0;
    c = ((((c << 21) | (c >>> 11)) >>> 0) + result) >>> 0;
  }

  // 返回生成器函数
  const rng = function() {
    const result = (a + b + counter) >>> 0;
    counter = (counter + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + ((c << 3) >>> 0)) >>> 0;
    c = ((((c << 21) | (c >>> 11)) >>> 0) + result) >>> 0;
    return result / 4294967296;
  };

  // 附加状态访问方法（用于调试）
  rng.getState = () => ({ a, b, c, counter });
  rng.setState = (state) => {
    a = state.a >>> 0;
    b = state.b >>> 0;
    c = state.c >>> 0;
    counter = state.counter >>> 0;
  };

  return rng;
}

/**
 * 验证 RNG 对齐（运行此函数并与 Python 输出对比）
 */
export function verifyAlignment() {
  const rng = createSFC32(12345);
  console.log('SFC32 alignment test (seed=12345):');
  console.log('First 10 values:');
  for (let i = 0; i < 10; i++) {
    console.log(`  ${i}: ${rng().toFixed(16)}`);
  }
}
