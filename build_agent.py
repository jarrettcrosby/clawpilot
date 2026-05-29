#!/usr/bin/env python3
"""
ClawPilot Build Agent
I (Sonnet) write the spec and review. gpt-4.1 does the coding.
This script runs an iteration loop: generate → write → build → fix → repeat.
"""
import subprocess, json, urllib.request, os, sys, time

key = subprocess.check_output("grep OPENAI_API_KEY ~/.zshrc | tail -1 | cut -d'\"' -f2", shell=True).decode().strip()
PROJECT = os.path.expanduser('~/clawd-app')
APP_DIR = os.path.join(PROJECT, 'app_src')  # Next.js lives here

def gpt(messages, max_tokens=4000, model='gpt-4.1'):
    payload = json.dumps({'model': model, 'messages': messages, 'max_tokens': max_tokens}).encode()
    req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=payload, method='POST')
    req.add_header('Authorization', f'Bearer {key}')
    req.add_header('Content-Type', 'application/json')
    r = json.loads(urllib.request.urlopen(req, timeout=120).read())
    code = r['choices'][0]['message']['content'].strip()
    if '```' in code:
        lines = code.split('\n')
        start = next((i+1 for i,l in enumerate(lines) if l.startswith('```')), 0)
        end = next((i for i,l in enumerate(lines[start:], start) if l.strip()=='```'), len(lines))
        code = '\n'.join(lines[start:end])
    tokens = r['usage']['total_tokens']
    finish = r['choices'][0]['finish_reason']
    return code, tokens, finish

def build():
    result = subprocess.run('npm run build', shell=True, cwd=APP_DIR, capture_output=True, text=True, timeout=120)
    return result.returncode == 0, result.stdout + result.stderr

def write_file(path, content):
    full = os.path.join(APP_DIR, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w') as f:
        f.write(content)
    print(f'  wrote {path} ({len(content.splitlines())} lines)')

def read_memory():
    try: return open(os.path.join(PROJECT, 'AGENT_MEMORY.md')).read()
    except: return ''

def read_spec():
    try: return open(os.path.join(PROJECT, 'SPEC.md')).read()
    except: return ''

def update_memory(lesson):
    path = os.path.join(PROJECT, 'AGENT_MEMORY.md')
    with open(path, 'a') as f:
        f.write(f'\n\n## Session {time.strftime("%Y-%m-%d %H:%M")}\n{lesson}')

def iterate(task, file_path, max_attempts=4):
    """Generate code, write file, build, fix errors, repeat."""
    memory = read_memory()
    spec = read_spec()

    system = f"""You are an expert Next.js/TypeScript/MUI developer building a production app.
Read these carefully before writing any code:

SPEC:
{spec[:2000]}

MEMORY (lessons learned — do NOT repeat these mistakes):
{memory[:2000]}

Rules:
- Return ONLY valid TypeScript/TSX code. No markdown fences, no explanation.
- Use MUI v6 components exclusively for UI (no Tailwind, no custom CSS classes)
- Material Design 3 dark theme colors as specified in SPEC
- Mobile-first: bottom nav on mobile, sidebar on desktop
- 'use client' on any component using React hooks
- Every touch target minimum 48px height"""

    messages = [{"role":"system","content":system}, {"role":"user","content":task}]
    
    for attempt in range(1, max_attempts+1):
        print(f'\n  Attempt {attempt}/{max_attempts}...')
        code, tokens, finish = gpt(messages)
        print(f'  Generated: {len(code.splitlines())} lines | {tokens} tokens | finish:{finish}')
        
        write_file(file_path, code)
        success, output = build()
        
        if success:
            print(f'  ✅ Build passed!')
            update_memory(f'✅ {file_path}: succeeded on attempt {attempt}')
            return True
        else:
            errors = [l for l in output.split('\n') if 'error' in l.lower() or 'Error' in l][:10]
            error_summary = '\n'.join(errors)
            print(f'  ❌ Build failed:\n{error_summary}')
            
            # Feed errors back to gpt-4.1 for fixing
            messages.append({"role":"assistant","content":code})
            messages.append({"role":"user","content":f"Build failed with these errors:\n{error_summary}\n\nFix all errors and return the complete corrected file."})
    
    update_memory(f'❌ {file_path}: failed after {max_attempts} attempts. Last errors: {error_summary[:200]}')
    return False

if __name__ == '__main__':
    task = sys.argv[1] if len(sys.argv) > 1 else 'status'
    print(f'Build Agent ready. Task: {task}')
    print(f'Project: {PROJECT}')
    print(f'App: {APP_DIR}')
