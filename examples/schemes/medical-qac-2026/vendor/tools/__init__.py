"""tools 包：让 `from tools.measure import weigh` 在方案目录内可解析。

【来源】原仓库 tools/ 是隐式命名空间包，没有 __init__.py；这里补一个空的，
否则某些 Python 调用方式（sys.path 指向 vendor/）会找不到子模块。
【位置】随 medical-qac-2026 方案分发，不属于插件通用层
"""
