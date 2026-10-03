-- AX helper for the Argo 0.1.89 updater reproduction (CI runner only; never merged to main).
-- usage:
--   osascript ax.applescript dump                     every element of the front Argo window, one per line
--   osascript ax.applescript find  <label>...         FOUND if a button/link label equals one of <label>
--   osascript ax.applescript click <label>...         press the first button/link whose label equals <label>
--   osascript ax.applescript clickc <substr>...       press the first button/link whose label contains <substr>
--   osascript ax.applescript reveal <substr>          scroll the first element containing <substr> into view
--   osascript ax.applescript type <text>              focus the first text field, type <text>, press return
--   osascript ax.applescript gk-open                  press "Open" on the Gatekeeper first-launch dialog
--   osascript ax.applescript sa-dump | sa-cancel      inspect / cancel the SecurityAgent admin prompt

on run argv
	set act to item 1 of argv
	if act is "gk-open" then return gkOpen()
	if act is "sa-dump" then return saDump()
	if act is "sa-cancel" then return saCancel()
	tell application "System Events"
		set ps to (every process whose bundle identifier is "com.beyondworks.argo")
		if (count of ps) is 0 then return "NO_PROCESS"
		set p to item 1 of ps
		try
			set frontmost of p to true
		end try
		if (count of windows of p) is 0 then return "NO_WINDOW"
		set els to entire contents of window 1 of p
	end tell
	if act is "dump" then
		set out to ""
		repeat with e in els
			set out to out & my describe(e) & linefeed
		end repeat
		return out
	else if act is "find" or act is "click" or act is "clickc" then
		set wanted to rest of argv
		repeat with e in els
			set r to my roleOf(e)
			if r is in {"AXButton", "AXLink", "AXMenuItem"} then
				set labels to my labelsOf(e)
				repeat with w in wanted
					repeat with lb in labels
						set hit to false
						if act is "clickc" then
							if (lb as text) contains (w as text) then set hit to true
						else
							if (lb as text) is (w as text) then set hit to true
						end if
						if hit then
							if act is "find" then return "FOUND " & r & " " & (lb as text)
							tell application "System Events" to perform action "AXPress" of e
							return "CLICKED " & r & " " & (lb as text)
						end if
					end repeat
				end repeat
			end if
		end repeat
		return "NOT_FOUND"
	else if act is "reveal" then
		set wanted to item 2 of argv
		repeat with e in els
			if (my describe(e)) contains wanted then
				try
					tell application "System Events" to perform action "AXScrollToVisible" of e
				end try
				return "REVEALED"
			end if
		end repeat
		return "NOT_FOUND"
	else if act is "type" then
		repeat with e in els
			if my roleOf(e) is "AXTextField" then
				tell application "System Events"
					set focused of e to true
					delay 0.5
					keystroke (item 2 of argv)
					delay 0.5
					key code 36
				end tell
				return "TYPED"
			end if
		end repeat
		return "NO_TEXTFIELD"
	end if
	return "UNKNOWN_ACTION"
end run

on roleOf(e)
	tell application "System Events"
		try
			return (role of e) as text
		on error
			return "?"
		end try
	end tell
end roleOf

on labelsOf(e)
	set L to {}
	tell application "System Events"
		try
			set end of L to ((name of e) as text)
		end try
		try
			set end of L to ((description of e) as text)
		end try
		try
			set end of L to ((title of e) as text)
		end try
	end tell
	return L
end labelsOf

on describe(e)
	set r to my roleOf(e)
	set L to my labelsOf(e)
	set v to ""
	tell application "System Events"
		try
			set v to ((value of e) as text)
		end try
	end tell
	set AppleScript's text item delimiters to " | "
	set s to r & " | " & (L as text) & " || " & v
	set AppleScript's text item delimiters to ""
	return s
end describe

on gkOpen()
	tell application "System Events"
		repeat with pn in {"CoreServicesUIAgent", "UserNotificationCenter"}
			if exists process (pn as text) then
				tell process (pn as text)
					repeat with w in windows
						repeat with b in buttons of w
							if (name of b) is in {"Open", "열기"} then
								click b
								return "GK_OPENED via " & (pn as text)
							end if
						end repeat
					end repeat
				end tell
			end if
		end repeat
	end tell
	return "GK_NOT_FOUND"
end gkOpen

on saDump()
	tell application "System Events"
		if not (exists process "SecurityAgent") then return "NO_SECURITYAGENT"
		set out to ""
		tell process "SecurityAgent"
			repeat with w in windows
				set els to entire contents of w
				repeat with e in els
					set out to out & my describe(e) & linefeed
				end repeat
			end repeat
		end tell
		return out
	end tell
end saDump

on saCancel()
	tell application "System Events"
		if not (exists process "SecurityAgent") then return "NO_SECURITYAGENT"
		tell process "SecurityAgent"
			repeat with w in windows
				repeat with b in buttons of w
					if (name of b) is in {"Cancel", "취소"} then
						click b
						return "SA_CANCELLED"
					end if
				end repeat
			end repeat
		end tell
	end tell
	return "SA_NO_CANCEL_BUTTON"
end saCancel
