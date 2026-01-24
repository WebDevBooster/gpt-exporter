# GPT Exporter

Chrome browser extension to easily export either all or only new/updated ChatGPT conversations as Markdown files optimized for [Obsidian](https://obsidian.md/).

Because I couldn't find a tool that does what I want, I built my own. 

Note:  
This extension is deliberately designed to work *slowly* and will also make a random pause between 2 and 4 minutes after downloading every 100 conversations. This is to avoid any potential issues like rate limiting that ChatGPT might implement.  
As a result, on average it downloads only about 10 conversations per minute. So, if you have 1,500 conversations in total, it could take 2.5 hours to download all. 

During the download process you should NOT open new ChatGPT windows/tabs and should NOT work in existing ChatGPT tabs. Just pause all of your ChatGPT activity until the download is finished. 

Also, I recommend that you ONLY enable this browser extension for dowloading new or updated ChatGPT threads/conversations (or downloading all initially) and then **disable the GPT Exporter extension afterwards**. Because otherwise it will make the loading of ChatGPT pages slower. It will remember all the settings when you re-enable it later. 

During the download process you can open a new browser window and do any non-ChatGPT tasks there. 

If you use **Projects** in ChatGPT (like I do) to organize things, GPT Exporter will automatically create folders with those project names and put all the corresponding `.md` files inside. 

