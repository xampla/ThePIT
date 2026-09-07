# Nova rules in use

Generated from `nova-service/rules` (community nova-rules, unmodified). Thresholds are per pattern; a rule without an explicit threshold gets Nova's default 0.1. "sem alone" = the condition lets a semantic pattern fire the rule by itself (no keyword needed).

| rule | severity | category | keywords | semantic thresholds | llm thresholds | sem alone | condition |
|---|---|---|---|---|---|---|---|
| JoinInjectionString | medium | prompt_manipulation/indirect_injection | 5 | 0.1, 0.1 | 0.1, 0.2 | yes | `(keywords.$join_command or semantics.$string_joining or llm.$join_link_eval) and (keywords.$link_intent or sem` |
| BindShellPrompt | high | abusing_functions/malware_generation | 5 | 0.2, 0.2 | 0.2 | yes | `(keywords.$socket_ref and (keywords.$connect_func or keywords.$tcp_ref)) and (semantics.$reverse_connection or` |
| DestructiveSystemCleaner | critical | abusing_functions/agentic_misuse | 6 | 0.2, 0.2, 0.2 | 0.2 | yes | `(keywords.* or semantics.*) and llm.$check_destruction` |
| ExfiltrateDocumentsOneLiner | high | abusing_functions/contextual_exfiltration | 6 | 0.2 | 0.2 | yes | `(keywords.$copy_cmd or keywords.$onedoc) and (keywords.$source_docs or keywords.$source_dl or keywords.$source` |
| KawaiiPersonaEnforcementBypass | high | prompt_manipulation/jailbreak | 7 | 0.2, 0.2, 0.2 | 0.2 | yes | `(keywords.* or semantics.* or llm.$eval_bypass)` |
| LLMImproperOutputHandling | high | abnormal_outputs/malicious_content | 8 | 0.2, 0.2 | 0.0, 0.0 | yes | `any of keywords.* or any of semantics.* or any of llm.*` |
| PolicyPuppetryUniversalBypass | critical | prompt_manipulation/jailbreak | 6 | 0.2, 0.2, 0.2 | 0.2 | yes | `(keywords.$policy_tag and (keywords.$roleplay_mode or keywords.$scene_rules or keywords.$leet_speak_hint)) or ` |
| ReceiveCommandExecPrompt | high | abusing_functions/malware_generation | 6 | 0.2, 0.2 | 0.2 | yes | `// MODIFIED: Added $exec_words and $send_output to the condition (keywords.$socket and (keywords.$receive_fn o` |
| ReconGatherWriteCommand | high | abusing_functions/reconnaissance | 10 | 0.2, 0.2 | 0.2 | yes | `(keywords.$cmd_list or keywords.$oneline) and (keywords.$hardware or keywords.$network or keywords.$services o` |
| RoutineDataExfiltration | high | prompt_manipulation/indirect_injection | 6 | 0.2, 0.2 | 0.2 | yes | `3 of keywords.* or semantics.* or llm.$injection_check` |
| CodeSwitchingJailbreak | high | abnormal_outputs/malicious_content | 0 | 0.3 | 0.3 | yes | `semantics.$violation_intent or llm.$code_switch_check` |
| DanJailbreak | high | prompt_manipulation/jailbreak | 4 | 0.3 | — | yes | `($dan_phrase and $role_instruction) or ($bypass_rules and $content_policy) or semantics.$jailbreak_intent` |
| DetectHiddenInstructions | medium | prompt_manipulation/indirect_injection | 14 | 0.3, 0.3 | — | yes | `any of keywords.* or any of semantics.*` |
| DetectImpersonationAttempts | medium | abusing_functions/social_engineering | 15 | 0.3, 0.3 | — | yes | `any of keywords.* or any of semantics.*` |
| DetectSuspiciousScriptPatterns | high | abusing_functions/supply_chain | 33 | 0.4, 0.4, 0.3, 0.4 | — | yes | `any of keywords.* or any of semantics.*` |
| RoleplayManipulationSexualMisconduct | high | prompt_manipulation/jailbreak | 3 | 0.3 | 0.2 | yes | `(keywords.$sexual and keywords.$innocent and keywords.$save) or semantics.$roleplay_accusation or llm.$manipul` |
| CognitiveHackingJailbreak | high | prompt_manipulation/jailbreak | 9 | 0.35, 0.35, 0.35 | 0.6 | yes | `(2 of keywords.* or any of semantics.*) and llm.$cognitive_check` |
| DANJailbreak | high | prompt_manipulation/jailbreak | 9 | 0.35, 0.4 | — | yes | `keywords.$dan_mode or keywords.$do_anything or keywords.$ignore_rules or keywords.$ignore_ethics or keywords.$` |
| RoleplayJailbreak | medium | prompt_manipulation/jailbreak | 0 | 0.35, 0.35, 0.35, 0.35, 0.35 | 0.6 | yes | `(any of semantics.*) and llm.$roleplay_check` |
| CVEInformationRequestRule | medium | abusing_functions/reconnaissance | 8 | 0.4, 0.4 | 0.7 | no | `$cve and ($exploit or $vulnerability or $details or $information or $how_to or $poc or $poc_short) and (any of` |
| DataExfiltrationPrompt | high | abusing_functions/data_exfiltration | 4 | 0.4, 0.4 | 0.35 | yes | `(keywords.$send_data and keywords.$external_service) or keywords.$exfil or (keywords.$sensitive_request and ke` |
| DetectDataExfiltration | critical | abusing_functions/data_exfiltration | 26 | 0.5, 0.4, 0.5 | — | yes | `any of keywords.* or any of semantics.*` |
| DetectMaliciousToolPermissions | high | abusing_functions/agentic_misuse | 18 | 0.4, 0.4 | — | yes | `any of keywords.* or any of semantics.*` |
| DetectScamMessageInjection | high | prompt_manipulation/indirect_injection | 5 | 0.4, 0.4 | 0.5 | no | `llm.$analyze_scam_injection or ( (keywords.$fake_tag or keywords.$force_command or keywords.$force_response) a` |
| DetectSkillPromptInjection | critical | prompt_manipulation/direct_injection | 30 | 0.4, 0.4, 0.4 | — | yes | `any of keywords.* or any of semantics.*` |
| GovernmentPhishingThemeRule | high | abusing_functions/social_engineering | 23 | 0.4, 0.4 | 0.8 | no | `($theme or $themes or $topic or $subject) and ($interesting or $engaging or $attention) and ($employee or $emp` |
| IndirectPromptInjection | high | prompt_manipulation/indirect_injection | 5 | 0.4, 0.4 | 0.35 | yes | `((keywords.$summarize or keywords.$analyze or keywords.$review) and keywords.$external_link) or keywords.$hidd` |
| IndirectTaskDeflectionJailbreak | medium | prompt_manipulation/jailbreak | 0 | 0.6, 0.5, 0.5, 0.5, 0.4 | — | no | `2 of semantics.*` |
| JobRecruitmentVariationRule | high | abusing_functions/social_engineering | 19 | 0.4, 0.4 | 0.8 | no | `($variation or $variations or $alternate or $alternative or $different or $version or $rewrite or $rephrase) a` |
| MalwareCreationRule | high | abusing_functions/malware_generation | 9 | 0.4 | — | yes | `// Detect 3/5 core components (keywords.$safety_override or keywords.$ethical_bypass) and (keywords.$hacker_pe` |
| MessagingScriptingRule | medium | abusing_functions/crime_automation | 15 | 0.4, 0.4 | 0.7 | no | `($code or $script or $program) and ($sms or $text or $message) and ($send or $sending or $programmatically or ` |
| MultiTechniqueInjectionDetection | high | prompt_manipulation/direct_injection | 4 | 0.4 | — | yes | `any of keywords.* or semantics.$multi_tech` |
| MultimodalInjection | high | suspicious_patterns/cross_modal | 4 | 0.4, 0.4 | 0.3 | yes | `(keywords.$image_process and (keywords.$hidden_content or keywords.$watermark)) or keywords.$multimodal or sem` |
| PayloadSplittingAttack | high | suspicious_patterns/fragmentation | 3 | 0.4, 0.4 | 0.3 | yes | `keywords.$continuation or keywords.$split_content or keywords.$fragment or semantics.$combining_instructions o` |
| SecurityToolExtensionRule | medium | abusing_functions/crime_automation | 15 | 0.4, 0.4 | 0.7 | no | `(any of keywords.* and any of semantics.*) or llm.$extension_check` |
| SensitiveInfoDisclosure | high | abnormal_outputs/pii_exposure | 9 | 0.4, 0.4, 0.4 | 0.0 | yes | `(keywords.* or semantics.* or llm.$leak_eval)` |
| TargetedExploitResearchRule | high | abusing_functions/reconnaissance | 18 | 0.4, 0.4 | 0.8 | no | `($exploit or $vulnerability or $hack or $breach) and ($infrastructure or $network or $system or $server) and (` |
| VirtualizationInjectionDetection | medium | prompt_manipulation/jailbreak | 4 | 0.4 | — | no | `(any of keywords.*) and semantics.$virtual_context` |
| VulnerabilityReconnaissanceRule | medium | abusing_functions/reconnaissance | 9 | 0.4, 0.4 | 0.7 | yes | `(2 of keywords.$vuln_terms* and 1 of keywords.$app_reference*) or (any of semantics.*) and llm.$recon_check` |
| WebShellExploitRule | high | abusing_functions/malware_generation | 12 | 0.4, 0.4 | 0.8 | no | `$sqlmap and ($webshell or $webshell2 or $shell) and ($upload or $inject) and ($execute or $rce or $sql_injecti` |
| CodeInjectionPrompt | high | prompt_manipulation/hidden_instructions | 5 | 0.5, 0.5 | 0.3 | yes | `(keywords.$execute or keywords.$run or keywords.$evaluate) or (keywords.$code_block and keywords.$system_acces` |
| DirectPromptInjection | high | prompt_manipulation/direct_injection | 7 | 0.5, 0.5 | 0.35 | yes | `(any of keywords.*) or semantics.$bypass_instructions or semantics.$change_behavior or llm.$instruction_overri` |
| HiddenHtmlLlmDestructiveCommandInjection | critical | prompt_manipulation/indirect_injection | 4 | 0.5 | 0.7 | yes | `($ai_address and $override and $destructive) or ($hidden_html and $destructive) or (semantics.$injection_inten` |
| AdversarialInjectionDetection | high | prompt_manipulation/direct_injection | 3 | — | — | no | `2 of keywords.*` |
| ClaudeConversationEnders | medium | prompt_manipulation/indirect_injection | 2 | — | — | no | `keywords.$ender1 or keywords.$ender2` |
| ClaudeRefusalMagicString | medium | prompt_manipulation/indirect_injection | 2 | — | — | no | `keywords.$magicstring1 or keywords.$magicstring2` |
| CodeExecutionInjectionDetection | high | prompt_manipulation/hidden_instructions | 5 | — | — | no | `keywords.*` |
| DPRKExpertSpearPhishing | high | abusing_functions/social_engineering | 1 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
| DPRKNGORecon | high | abusing_functions/reconnaissance | 4 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
| DefenseEvasionAvCrimsonSandstorm | medium | abusing_functions/attack_enablement | 2 | — | 0.35 | no | `(keywords.$av_bypass and keywords.$av) and llm.$defense_evasion` |
| DefenseEvasionCodeCrimsonSandstorm | medium | abusing_functions/attack_enablement | 2 | — | 0.35 | no | `(keywords.$evasion or keywords.$cleanup) and llm.$defense_evasion` |
| DetectInvisibleUnicodeInjection | high | suspicious_patterns/unicode_tricks | 2 | — | 0.45, 0.45 | no | `keywords.$unicode_tags_block or keywords.$zero_width_present or llm.$llm_invisible_prompt or llm.$llm_unicode_` |
| DeveloperModeJailbreak1 | medium | prompt_manipulation/jailbreak | 1 | — | 0.6 | no | `keywords.$dev_mode and llm.$dev_mode_check` |
| DirectInstructionManipulationDetection | high | prompt_manipulation/direct_injection | 4 | — | — | no | `2 of keywords.*` |
| IndirectInjectionDetection | medium | prompt_manipulation/indirect_injection | 4 | — | — | no | `any of keywords.*` |
| InjectDynamicContext | high | abusing_functions/agentic_misuse | 1 | — | — | no | `keywords.$command_placeholder` |
| MSDTResearch | high | abusing_functions/reconnaissance | 3 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
| ObfuscationInjectionDetection | medium | suspicious_patterns/encoding_obfuscation | 1 | — | 0.7 | no | `keywords.$base64 or llm.$obfuscation_check` |
| OperationsResearch | high | abusing_functions/reconnaissance | 4 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
| PhishingCrimsonSandstorm | medium | abusing_functions/social_engineering | 3 | — | 0.35 | no | `(keywords.$geo_target and keywords.$industry_target and keywords.$lure) and llm.$phishing` |
| PromptInjectionJailbreak | high | prompt_manipulation/direct_injection | 14 | — | — | no | `any of keywords.*` |
| PromptLeakageDetection | high | abnormal_outputs/system_prompt_leak | 4 | — | 0.7 | no | `any of keywords.* or llm.$code_injection_check` |
| ScriptingSupport | high | abusing_functions/crime_automation | 4 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
| TokenSmugglingJailbreak | medium | suspicious_patterns/encoding_obfuscation | 0 | — | 0.7, 0.7, 0.6 | no | `any of llm.*` |
| UserEventResearch | high | abusing_functions/attack_enablement | 2 | — | 0.35 | no | `(any of keywords.*) and (any of llm.*)` |
