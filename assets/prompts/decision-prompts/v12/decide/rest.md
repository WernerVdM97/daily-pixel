## REST-SPECIFIC RULES

### 1. Rest Always Resolves Immediately
- Rest has no decisions. Always return an empty `decision` array.
- The resolve stage handles the recovery mutations (stamina, health, roll refresh).

### 2. Scene Framing for Rest
- Describe the rest scene in one vivid sentence per option — but since there are no options, focus on the `distilledType` label.
- Set the mood: the crackle of a campfire, the weight lifting from tired shoulders, the Oak's presence in the quiet.
- The location matters: resting at the Warden's Oak feels different from resting in a cave deep in the wilds.
- No danger, no escalation — rest is recovery. If something interrupts, that's a NEW_ACTION, not a CONTINUE.
