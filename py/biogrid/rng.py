"""可复现随机数生成器 - SFC32 算法

用于 tick-by-tick 严格对齐：JS 和 Python 使用相同算法和种子，
产生完全一致的 [0,1) 浮点序列。

SFC32 (Small Fast Chaotic 32-bit) 特点：
- 周期长（约 2^128）
- 速度快
- 统计质量好
- 实现简单，易于跨语言对齐
"""

import numpy as np
import warnings
from typing import Tuple

# 抑制 numpy uint32 溢出警告（这是预期行为）
warnings.filterwarnings('ignore', category=RuntimeWarning, message='overflow encountered')

# 使用 Python int 进行位运算，然后截断到 32 位
MASK32 = 0xFFFFFFFF


class SFC32:
    """SFC32 随机数生成器 - 可跨语言复现"""

    def __init__(self, seed: int = 0):
        """初始化 RNG

        Args:
            seed: 32位种子值
        """
        # 状态初始化（使用 Python int，手动截断）
        self.a = 0
        self.b = 0
        self.c = 0
        self.counter = 1

        # 用种子初始化状态
        self._seed(seed)

    def _seed(self, seed: int):
        """设置种子"""
        seed = seed & MASK32
        self.a = seed
        self.b = seed
        self.c = seed
        self.counter = 1

        # 预热（丢弃前 15 个值以充分混合状态）
        for _ in range(15):
            self._next_u32()

    def _next_u32(self) -> int:
        """生成下一个 32 位无符号整数"""
        # SFC32 核心算法（使用 Python int + 手动截断，避免 numpy 警告）
        a, b, c, counter = self.a, self.b, self.c, self.counter

        # 计算输出
        result = (a + b + counter) & MASK32
        counter = (counter + 1) & MASK32

        # 更新状态
        a_new = (b ^ (b >> 9)) & MASK32
        b_new = (c + ((c << 3) & MASK32)) & MASK32
        c_new = ((((c << 21) | (c >> 11)) & MASK32) + result) & MASK32

        self.a = a_new
        self.b = b_new
        self.c = c_new
        self.counter = counter

        return result

    def random(self) -> float:
        """生成 [0, 1) 范围的浮点数

        与 JS Math.random() 语义一致
        """
        # 使用 32 位整数的高 23 位来生成 float
        # 这与 JS 的实现方式一致
        u = self._next_u32()
        # 转换为 [0, 1) 浮点数
        return float(u) / 4294967296.0  # 2^32

    def __call__(self) -> float:
        """允许像函数一样调用"""
        return self.random()

    def get_state(self) -> Tuple[int, int, int, int]:
        """获取当前状态（用于保存/恢复）"""
        return (self.a, self.b, self.c, self.counter)

    def set_state(self, state: Tuple[int, int, int, int]):
        """恢复状态"""
        self.a = state[0] & MASK32
        self.b = state[1] & MASK32
        self.c = state[2] & MASK32
        self.counter = state[3] & MASK32

    def clone(self) -> 'SFC32':
        """克隆当前 RNG（保持状态）"""
        new_rng = SFC32.__new__(SFC32)
        new_rng.a = self.a
        new_rng.b = self.b
        new_rng.c = self.c
        new_rng.counter = self.counter
        return new_rng


# 用于 JS 侧对齐的参考实现（可直接复制到 JS）
JS_SFC32_IMPL = '''
// SFC32 - 与 Python 实现对齐
function createSFC32(seed) {
  let a = seed >>> 0;
  let b = seed >>> 0;
  let c = seed >>> 0;
  let counter = 1;

  // 预热
  for (let i = 0; i < 15; i++) {
    const result = (a + b + counter) >>> 0;
    counter = (counter + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = (((c << 21) | (c >>> 11)) + result) >>> 0;
  }

  return function() {
    const result = (a + b + counter) >>> 0;
    counter = (counter + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = (((c << 21) | (c >>> 11)) + result) >>> 0;
    return result / 4294967296;
  };
}
'''


def verify_alignment():
    """验证 Python 和 JS 实现的对齐性

    运行此函数并与 JS 输出对比，确保两边一致
    """
    rng = SFC32(12345)
    print("SFC32 alignment test (seed=12345):")
    print("First 10 values:")
    for i in range(10):
        print(f"  {i}: {rng.random():.16f}")


if __name__ == '__main__':
    verify_alignment()
