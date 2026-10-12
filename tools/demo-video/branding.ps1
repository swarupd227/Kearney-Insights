# Builds the Artizent intro and outro clips (1920x1080, 25 fps, 5 s each, with a silent stereo track so they concatenate with the cuts).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logo = 'artizent-logo.png'
# Fonts are copied next to the script and referenced relatively: a drive-letter colon inside a filtergraph is not parsed reliably on Windows.
Copy-Item C:\Windows\Fonts\segoeui.ttf "$here\segoeui.ttf" -Force; Copy-Item C:\Windows\Fonts\segoeuib.ttf "$here\segoeuib.ttf" -Force
Push-Location $here
$fontB = 'segoeuib.ttf'; $font = 'segoeui.ttf'
$bg = '0x0f172a'; $W = 1920; $H = 1080
$common = "[1:v]scale=540:-1[logo];[0:v][logo]overlay=(W-w)/2:150[v0]"
$intro = "$common;[v0]drawbox=x=(iw-420)/2:y=372:w=420:h=3:color=0xf5c518@1:t=fill,drawtext=fontfile=${font}:text='presents':x=(w-text_w)/2:y=412:fontsize=28:fontcolor=0xb8c0d0,drawtext=fontfile=${fontB}:text='Astra Insights for Kearney':x=(w-text_w)/2:y=488:fontsize=76:fontcolor=white,drawtext=fontfile=${font}:text='Agentic, voice-enabled insights for the partnership':x=(w-text_w)/2:y=610:fontsize=34:fontcolor=0xd6dbe6,drawtext=fontfile=${font}:text='Ask in plain words. Every answer explains itself. Every action waits for a person.':x=(w-text_w)/2:y=668:fontsize=26:fontcolor=0x9aa3b5,fade=t=in:st=0:d=0.6,fade=t=out:st=4.4:d=0.6[v]"
$outro = "$common;[v0]drawbox=x=(iw-420)/2:y=372:w=420:h=3:color=0xf5c518@1:t=fill,drawtext=fontfile=${font}:text='Agentic insights for professional services':x=(w-text_w)/2:y=425:fontsize=34:fontcolor=0xd6dbe6,drawtext=fontfile=${font}:text='Learn more at':x=(w-text_w)/2:y=560:fontsize=28:fontcolor=0xb8c0d0,drawtext=fontfile=${fontB}:text='www.artizent.com':x=(w-text_w)/2:y=608:fontsize=64:fontcolor=0xf5c518,fade=t=in:st=0:d=0.6,fade=t=out:st=4.4:d=0.6[v]"
$enc = @('-map','[v]','-map','2:a','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-r','25','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-shortest')
ffmpeg -v error -y -f lavfi -i "color=c=${bg}:s=${W}x${H}:r=25:d=5" -i $logo -f lavfi -i "anullsrc=r=48000:cl=stereo:d=5" -filter_complex $intro @enc "$here/intro.mp4"
ffmpeg -v error -y -f lavfi -i "color=c=${bg}:s=${W}x${H}:r=25:d=5" -i $logo -f lavfi -i "anullsrc=r=48000:cl=stereo:d=5" -filter_complex $outro @enc "$here/outro.mp4"
ffmpeg -v error -y -ss 2.5 -i "$here/intro.mp4" -frames:v 1 "$here/intro-check.png"
ffmpeg -v error -y -ss 2.5 -i "$here/outro.mp4" -frames:v 1 "$here/outro-check.png"
Pop-Location
Write-Output "built intro.mp4 and outro.mp4"
