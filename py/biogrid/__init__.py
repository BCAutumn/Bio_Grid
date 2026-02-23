"""Bio-Grid: Python + Taichi 实现"""

from .config import DEFAULT_CONFIG, Config
from .state import World, CellType
from .rng import SFC32
from .tick import tick, compute_stats

__all__ = [
    'DEFAULT_CONFIG', 'Config',
    'World', 'CellType',
    'SFC32',
    'tick', 'compute_stats',
]

# Phase 2 渲染模块（需要 Taichi）
def get_renderer():
    """获取渲染器类（延迟导入，避免未安装 Taichi 时报错）"""
    from .render import TaichiRenderer, create_renderer
    return TaichiRenderer, create_renderer

def run_viewer(**kwargs):
    """启动交互式查看器"""
    from .viewer import run_viewer as _run_viewer
    _run_viewer(**kwargs)
