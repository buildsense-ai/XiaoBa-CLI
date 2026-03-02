import PyPDF2
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

reader = PyPDF2.PdfReader('pdfs/Agent-R1.pdf')
num_pages = len(reader.pages)
print(f'Pages: {num_pages}')

all_text = []
for i in range(num_pages):
    text = reader.pages[i].extract_text()
    if text:
        text = text.replace('\xa0', ' ')
        all_text.append(f'--- PAGE {i+1} ---\n{text}')

with open('pdfs/Agent-R1_full.txt', 'w', encoding='utf-8') as f:
    f.write('\n\n'.join(all_text))

print(f'Saved to pdfs/Agent-R1_full.txt')
print(f'Total chars: {sum(len(t) for t in all_text)}')
