import sys
import json
import os

# Fix encoding
sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)
sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', buffering=1)

# Read config from file
with open('docs/ppt/slides_config.json', 'r', encoding='utf-8') as f:
    config = json.load(f)

json_str = json.dumps(config, ensure_ascii=False)

# Set up sys.argv for BaseTool
sys.argv = ['pptx_generator_tool.py', json_str]

# Add tools path
sys.path.insert(0, os.path.join('tools', 'global'))
sys.path.insert(0, os.path.join('skills', 'paper-to-ppt'))

from pptx_generator_tool import PptxGeneratorTool
tool = PptxGeneratorTool()
tool.run()
