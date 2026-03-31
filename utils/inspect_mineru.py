from mineru_vl_utils import MinerUClient
import inspect

print("MinerUClient Init Args:")
try:
    sig = inspect.signature(MinerUClient.__init__)
    for name, param in sig.parameters.items():
        print(f"  {name}: {param.annotation} = {param.default}")
except Exception as e:
    print(e)
