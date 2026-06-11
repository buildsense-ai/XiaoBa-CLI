function extractCatsMessageText(message){
  if(!message)return '';
  if(catsMessageType(message)==='runtime_plan')return '';
  if(typeof message.content==='string')return message.content;
  if(Array.isArray(message.content_blocks)){
    return message.content_blocks.map(b=>b.text||b.content||'').filter(Boolean).join('\n');
  }
  if(message.content && typeof message.content==='object'){
    if(message.content.type && message.content.payload) return JSON.stringify(message.content.payload);
    return JSON.stringify(message.content);
  }
  return '';
}

function safeLinkUrl(value){
  const text=String(value||'').trim();
  if(/^https?:\/\//i.test(text))return text;
  if(/^mailto:/i.test(text))return text;
  return '';
}

function showCatsMediaPreview(src,title){
  window.__catscoRenderMediaPreview?.({src:src||'',title:title||'媒体预览'});
  window.__catscoSetGlobalModalOpen?.('mediaPreview', true);
}

function closeCatsMediaPreview(){
  window.__catscoSetGlobalModalOpen?.('mediaPreview', false);
  window.__catscoRenderMediaPreview?.({src:'',title:'预览'});
}

function isMarkdownTableSeparator(line){
  const cells=String(line||'').trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
  return cells.length>1 && cells.every(cell=>/^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line){
  const text=String(line||'').trim();
  return text.includes('|') && text.replace(/\|/g,'').trim().length>0;
}

function splitMarkdownTableRow(line){
  return String(line||'').trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
}

function parseInlineMarkdown(text){
  const source=String(text||'');
  const tokens=[];
  const pattern=/(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let lastIndex=0;
  let match;
  const pushText=value=>{
    if(value)tokens.push({kind:'text',text:value});
  };
  while((match=pattern.exec(source))){
    pushText(source.slice(lastIndex, match.index));
    const token=match[0];
    if(token.startsWith('`')){
      tokens.push({kind:'code',text:token.slice(1,-1)});
    }else if(token.startsWith('[')){
      const link=token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href=safeLinkUrl(link?.[2]||'');
      tokens.push(href?{kind:'link',href,text:link?.[1]||''}:{kind:'text',text:link?.[1]||token});
    }else if(token.startsWith('**') || token.startsWith('__')){
      tokens.push({kind:'strong',text:token.slice(2,-2)});
    }else if(token.startsWith('*') || token.startsWith('_')){
      tokens.push({kind:'em',text:token.slice(1,-1)});
    }else{
      pushText(token);
    }
    lastIndex=pattern.lastIndex;
  }
  pushText(source.slice(lastIndex));
  return tokens;
}

function parseMarkdownTable(lines){
  const header=splitMarkdownTableRow(lines[0]);
  const rows=lines.slice(2).map(splitMarkdownTableRow);
  return {
    header:header.map(parseInlineMarkdown),
    kind:'table',
    rows:rows.map(row=>header.map((_cell,idx)=>parseInlineMarkdown(row[idx]||''))),
  };
}

function parseMarkdownBlocks(text){
  const raw=String(text||'').replace(/\r\n/g,'\n');
  if(!raw.trim())return [];

  const codeBlocks=[];
  let source=raw.replace(/```([\w-]*)\n([\s\S]*?)```/g,(_,lang,code)=>{
    const token='@@CODE_BLOCK_'+codeBlocks.length+'@@';
    codeBlocks.push({kind:'codeBlock',lang:String(lang||''),text:String(code||'').replace(/\n$/,'')});
    return '\n'+token+'\n';
  });

  const lines=source.split('\n');
  const blocks=[];
  let paragraph=[];
  const flushParagraph=()=>{
    if(!paragraph.length)return;
    blocks.push({kind:'paragraph',lines:paragraph.map(parseInlineMarkdown)});
    paragraph=[];
  };

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const trimmed=line.trim();
    if(!trimmed){flushParagraph();continue;}
    const codeMarker=trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if(codeMarker){
      flushParagraph();
      const block=codeBlocks[Number(codeMarker[1])];
      if(block)blocks.push(block);
      continue;
    }
    if(isMarkdownTableRow(line) && i+1<lines.length && isMarkdownTableSeparator(lines[i+1])){
      flushParagraph();
      const tableLines=[line, lines[i+1]];
      i+=2;
      while(i<lines.length && isMarkdownTableRow(lines[i])){
        tableLines.push(lines[i]);
        i++;
      }
      i--;
      blocks.push(parseMarkdownTable(tableLines));
      continue;
    }
    const heading=trimmed.match(/^(#{1,3})\s+(.+)$/);
    if(heading){
      flushParagraph();
      blocks.push({kind:'heading',level:heading[1].length,inlines:parseInlineMarkdown(heading[2])});
      continue;
    }
    if(/^>\s?/.test(trimmed)){
      flushParagraph();
      const quote=[];
      while(i<lines.length && /^>\s?/.test(lines[i].trim())){
        quote.push(lines[i].trim().replace(/^>\s?/,''));
        i++;
      }
      i--;
      blocks.push({kind:'quote',lines:quote.map(parseInlineMarkdown)});
      continue;
    }
    if(/^[-*+]\s+/.test(trimmed)){
      flushParagraph();
      const items=[];
      while(i<lines.length && /^[-*+]\s+/.test(lines[i].trim())){
        items.push(parseInlineMarkdown(lines[i].trim().replace(/^[-*+]\s+/,'')));
        i++;
      }
      i--;
      blocks.push({kind:'list',ordered:false,items});
      continue;
    }
    if(/^\d+\.\s+/.test(trimmed)){
      flushParagraph();
      const items=[];
      while(i<lines.length && /^\d+\.\s+/.test(lines[i].trim())){
        items.push(parseInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/,'')));
        i++;
      }
      i--;
      blocks.push({kind:'list',ordered:true,items});
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
