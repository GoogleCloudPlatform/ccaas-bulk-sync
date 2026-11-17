/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { createApp, ref, onMounted, computed } = Vue;

createApp({
    setup() {
        const config = ref({
            ccaas: {},
            directory: {},
            mappings: [],
            schedule: {
                initialPollDelay: 15
            },
            safety: { maxDeactivations: 25 },
            syncOptions: { existingUsers: 'skip', syncNames: true },
            syncRole: ''
        });
        const ccaasDetails = ref({ teams: [], roles: [] });
        const directoryGroups = ref([]);
        const jobs = ref([]);
        const fileInput = ref(null);
        
        const jobsPagination = ref({
            currentPage: 1,
            perPage: 5,
            totalJobs: 0
        });
        
        const isLoading = ref(true);
        const isSaving = ref(false);
        const isSyncing = ref(false);
        const isFetchingDetails = ref(false);
        const isFetchingGroups = ref(false);
        const isTestingConnection = ref(false);
        const isLoadingJobs = ref(false);
        const isProcessingJob = ref(null);
        const isFetchingSchemeErrors = ref(null);

        const statusMessage = ref({ text: '', type: 'success', title: '' });
        const testResultModal = ref({ show: false, title: '', message: '', status: 'success' });
        const showGcpHelpModal = ref(false);
        const showSyncModal = ref(false);
        const me = ref({ email: null, role: 'viewer', adminListConfigured: true, serviceAccount: null });
        const isAdmin = computed(() => me.value.role === 'admin');
        const fetchMe = async () => {
            try {
                const response = await fetch(`${window.location.origin}/api/me`);
                if (response.ok) me.value = await response.json();
            } catch (error) {
                console.error('Failed to load user info:', error);
            }
        };
        const syncResultModal = ref({ show: false, title: '', message: '', status: 'success', preview: null, warnings: [], canOverride: false });
        const helpModal = ref({ show: false, title: '', content: '' });

        const totalPages = computed(() => {
            return Math.ceil(jobsPagination.value.totalJobs / jobsPagination.value.perPage);
        });

        const paginatedJobs = computed(() => {
            const start = (jobsPagination.value.currentPage - 1) * jobsPagination.value.perPage;
            const end = start + jobsPagination.value.perPage;
            return jobs.value.slice(start, end);
        });

        const nextPage = () => {
            if (jobsPagination.value.currentPage < totalPages.value) {
                jobsPagination.value.currentPage++;
            }
        };

        const prevPage = () => {
            if (jobsPagination.value.currentPage > 1) {
                jobsPagination.value.currentPage--;
            }
        };
        
        const changePerPage = () => {
            jobsPagination.value.currentPage = 1;
        };

        const parseCcaasHost = () => {
            let host = config.value.ccaas.host;
            if (host) {
                host = host.replace(/^https?:\/\//, '');
                const slashIndex = host.indexOf('/');
                if (slashIndex !== -1) host = host.substring(0, slashIndex);
                config.value.ccaas.host = host;
            }
        };

        const showStatusMessage = (text, type = 'success', title = '') => {
            statusMessage.value = { text, type, title };
            setTimeout(() => statusMessage.value.text = '', 5000);
        };
        
        const fetchConfig = async () => {
            isLoading.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/config`);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}. Server says: ${errorText}`);
                }
                const data = await response.json();
                
                config.value = { ...config.value, ...data };
                
                config.value.ccaas.apiKey = '';
                config.value.directory.gcpKey = '';
                config.value.directory.bindPassword = '';
                
                if (config.value.ccaas.host) {
                    getCcaasDetails();
                    fetchJobs();
                }
                if (config.value.directory.type) {
                    getDirectoryGroups();
                }
            } catch (error) {
                console.error("Fetch config error:", error);
                showStatusMessage('Failed to load configuration.', 'error');
            } finally {
                isLoading.value = false;
            }
        };
        
        const saveConfig = async () => {
            isSaving.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config.value)
                });
                if (!response.ok) {
                     const errorText = await response.text();
                    throw new Error(`Failed to save config: ${response.status} ${response.statusText}. Server says: ${errorText}`);
                }
                showStatusMessage('Configuration saved successfully. Secrets are updated.', 'success');
                config.value.ccaas.apiKey = '';
                config.value.directory.gcpKey = '';
                config.value.directory.bindPassword = '';
                config.value.directory.clientSecret = '';
            } catch (error) {
                console.error("Save config error:", error);
                showStatusMessage(error.message || 'Failed to save configuration.', 'error');
            } finally {
                isSaving.value = false;
            }
        };

        const RUN_PENDING = ['queued', 'running'];
        const waitForRun = async (runId) => {
            const deadline = Date.now() + 70 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                try {
                    const r = await fetch(`${window.location.origin}/api/sync-runs/${encodeURIComponent(runId)}`);
                    if (r.ok) {
                        const run = await r.json();
                        if (!RUN_PENDING.includes(run.outcome)) return run;
                    }
                } catch (error) {
                    console.warn('Polling sync run failed; retrying.', error);
                }
            }
            return { outcome: 'error', message: 'Timed out waiting for the sync job. Check Recent Sync Runs.' };
        };
        const showRunResult = (run) => {
            const ok = ['job_finished', 'no_changes'].includes(run.outcome);
            const titles = { job_finished: 'Sync Complete', no_changes: 'Sync Complete', blocked: 'Sync Blocked by Safety Check', group_not_found: 'Sync Aborted', in_progress: 'Another Sync Is Running' };
            syncResultModal.value = {
                show: true,
                title: titles[run.outcome] || 'Sync Failed',
                message: run.message,
                status: ok ? 'success' : 'error',
                preview: null,
                warnings: run.warningsCount ? [`${run.warningsCount} warning(s); see the service logs for details.`] : [],
                canOverride: run.outcome === 'blocked' && run.blockedReason === 'deactivation_limit'
            };
        };

        const runManualSync = async (simulate, allowLargeDeactivation = false) => {
            showSyncModal.value = false;
            syncResultModal.value.show = false;
            isSyncing.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ simulate: simulate, allowLargeDeactivation: allowLargeDeactivation })
                });
                const isJson = (response.headers.get('content-type') || '').includes('application/json');
                const data = isJson ? await response.json() : { message: await response.text() };

                if (response.status === 422 && data.blocked) {
                    syncResultModal.value = {
                        show: true, title: 'Sync Blocked by Safety Check', message: data.message, status: 'error',
                        preview: null, warnings: [], canOverride: data.reason === 'deactivation_limit'
                    };
                    return;
                }
                if (!response.ok) {
                    throw new Error(data.message || `Sync failed (${response.status}).`);
                }
                if (response.status === 202 && data.runId) {
                    // The live sync runs in a Cloud Run Job; follow its run record.
                    syncResultModal.value = { show: true, title: 'Sync Running', message: 'The sync job has started. This window updates when it finishes; you can close it and check Recent Sync Runs later.', status: 'success', preview: null, warnings: [], canOverride: false };
                    fetchRuns();
                    const run = await waitForRun(data.runId);
                    showRunResult(run);
                    fetchJobs();
                    return;
                }
                syncResultModal.value = {
                    show: true,
                    title: simulate ? 'Simulation Complete' : 'Sync Complete',
                    message: data.message,
                    status: data.blockedBy ? 'error' : 'success',
                    preview: data.preview || null,
                    warnings: data.warnings || [],
                    canOverride: false
                };
                if (!simulate) {
                    fetchJobs();
                }
            } catch (error) {
                console.error("Manual sync error:", error);
                syncResultModal.value = { show: true, title: 'Sync Error', message: error.message, status: 'error', preview: null, warnings: [], canOverride: false };
            } finally {
                isSyncing.value = false;
                fetchRuns();
            }
        };

        const confirmLargeDeactivation = () => {
            if (window.confirm('This will deactivate more users than the configured safety limit. Make sure you have reviewed a simulation. Continue?')) {
                runManualSync(false, true);
            }
        };

        const getCcaasDetails = async () => {
            if (!config.value.ccaas.host) {
                showStatusMessage('Please provide a CCaaS Host first.', 'error');
                return;
            }
            isFetchingDetails.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/ccaas-details`, {
                    method: 'POST'
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch details: ${response.status} ${response.statusText}. Server says: ${errorText}`);
                }
                ccaasDetails.value = await response.json();
            } catch (error) {
                console.error("Fetch CCaaS details error:", error);
                showStatusMessage('Could not fetch CCaaS details. Save config with a valid API Key.', 'error');
            } finally {
                isFetchingDetails.value = false;
            }
        };
        
        const getDirectoryGroups = async () => {
            isFetchingGroups.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/directory-groups`, {
                    method: 'POST'
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch groups: ${response.status} ${response.statusText}. Server says: ${errorText}`);
                }
                directoryGroups.value = await response.json();
            } catch (error) {
                console.error("Fetch directory groups error:", error);
                showStatusMessage('Could not fetch directory groups. Ensure directory is configured and connection works.', 'error');
            } finally {
                isFetchingGroups.value = false;
            }
        };
        
        const testCcaasConnection = async () => {
            isTestingConnection.value = true;
            try {
                 const payload = {
                    host: config.value.ccaas.host,
                    apiKey: config.value.ccaas.apiKey
                };
                if (!payload.apiKey) delete payload.apiKey;

                const response = await fetch(`${window.location.origin}/api/ccaas-test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Test failed');
                testResultModal.value = { show: true, title: 'Connection Successful', message: 'Successfully connected to the CCaaS API.', status: 'success' };
            } catch (error) {
                console.error("CCaaS connection test error:", error);
                testResultModal.value = { show: true, title: 'Connection Failed', message: `CCaaS Test Failed: ${error.message}`, status: 'error' };
            } finally {
                isTestingConnection.value = false;
            }
        };
        
        const testDirectoryConnection = async () => {
            isTestingConnection.value = true;
            try {
                const payload = { ...config.value.directory };
                if (!payload.gcpKey) delete payload.gcpKey;
                if (!payload.bindPassword) delete payload.bindPassword;

                const response = await fetch(`${window.location.origin}/api/directory-test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Test failed');

                let successMessage = `Successfully connected to ${config.value.directory.type === 'google' ? 'Google Workspace' : 'Active Directory'}.`;
                if(config.value.directory.type === 'entra') {
                    successMessage = "Successfully connected to Microsoft Entra ID.";
                }
                testResultModal.value = { show: true, title: 'Connection Successful', message: successMessage, status: 'success' };

            } catch (error) {
                console.error("Directory connection test error:", error);
                testResultModal.value = { show: true, title: 'Connection Failed', message: `Directory Test Failed: ${error.message}`, status: 'error' };
            } finally {
                isTestingConnection.value = false;
            }
        };

        const runs = ref([]);
        const isLoadingRuns = ref(false);
        const fetchRuns = async () => {
            isLoadingRuns.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/sync-runs?limit=20`);
                if (response.ok) runs.value = await response.json();
            } catch (error) {
                console.error('Failed to load sync runs:', error);
            } finally {
                isLoadingRuns.value = false;
            }
        };
        const runOutcomeClass = (outcome) => {
            if (['job_finished', 'no_changes'].includes(outcome)) return 'bg-green-100 text-green-800';
            if (outcome === 'simulated') return 'bg-blue-100 text-blue-800';
            if (['queued', 'running'].includes(outcome)) return 'bg-gray-100 text-gray-700';
            if (['blocked', 'group_not_found', 'in_progress'].includes(outcome)) return 'bg-yellow-100 text-yellow-800';
            return 'bg-red-100 text-red-800';
        };

        const fetchJobs = async () => {
            isLoadingJobs.value = true;
            try {
                const response = await fetch(`${window.location.origin}/api/ccaas-jobs`, { method: 'POST' });
                if (!response.ok) {
                     const errorText = await response.text();
                    throw new Error(`Failed to fetch jobs: ${response.status} ${response.statusText}. Server says: ${errorText}`);
                }
                const jobData = await response.json();
                jobs.value = jobData.map(j => ({...j, expanded: false }));
                jobsPagination.value.totalJobs = jobs.value.length;
            } catch(error) {
                 console.error("Fetch jobs error:", error);
                 showStatusMessage('Could not fetch CCaaS jobs. Ensure configuration is saved.', 'error');
            } finally {
                isLoadingJobs.value = false;
            }
        };
        
        const proceedJob = async (jobId) => {
            isProcessingJob.value = jobId;
            try {
                const response = await fetch(`${window.location.origin}/api/ccaas-jobs/proceed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: jobId })
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to proceed job: ${errorText}`);
                }
                showStatusMessage(`Successfully started processing for Job ID: ${jobId}.`, 'success');
                fetchJobs();
            } catch (error) {
                console.error("Proceed job error:", error);
                showStatusMessage(error.message, 'error', 'Proceed Error');
            } finally {
                isProcessingJob.value = null;
            }
        };

        const addMapping = () => {
            config.value.mappings.push({ group: '', rules: [{ type: 'team', value: '' }] });
        };

        const removeMapping = (index) => {
            config.value.mappings.splice(index, 1);
        };
        
        const addRule = (mappingIndex) => {
            config.value.mappings[mappingIndex].rules.push({ type: 'team', value: '' });
        };

        const removeRule = (mappingIndex, ruleIndex) => {
            config.value.mappings[mappingIndex].rules.splice(ruleIndex, 1);
        };

        const getStatusColor = (status) => {
            const colors = {
                created: 'bg-blue-100 text-blue-800',
                completed: 'bg-green-100 text-green-800',
                finished: 'bg-green-100 text-green-800',
                failed: 'bg-red-100 text-red-800',
                processing: 'bg-yellow-100 text-yellow-800',
                valid_scheme: 'bg-purple-100 text-purple-800',
                invalid_scheme: 'bg-red-100 text-red-800'
            };
            return colors[status] || 'bg-gray-100 text-gray-800';
        };
        
        const fetchSchemeErrors = async (jobId) => {
            const job = jobs.value.find(j => j.id === jobId);
            if(!job) return;

            isFetchingSchemeErrors.value = jobId;
            try {
                const response = await fetch(`${window.location.origin}/api/ccaas-jobs/scheme-errors/${jobId}`);
                if (!response.ok) {
                     throw new Error('Failed to fetch scheme errors.');
                }
                job.scheme_errors = await response.json();
            } catch (error) {
                console.error("Fetch scheme errors error:", error);
                showStatusMessage('Could not fetch scheme errors.', 'error');
            } finally {
                isFetchingSchemeErrors.value = null;
            }
        };

        const toggleJob = (jobId) => {
            const job = jobs.value.find(j => j.id === jobId);
            if (job) {
                job.expanded = !job.expanded;
                if (job.expanded && job.status === 'invalid_scheme' && !job.scheme_errors) {
                    fetchSchemeErrors(jobId);
                }
            }
        };
        
        const triggerFilePicker = () => {
            fileInput.value.click();
        };
        
        const handleFileImport = (event) => {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    JSON.parse(e.target.result);
                    config.value.directory.gcpKey = e.target.result;
                } catch (err) {
                    showStatusMessage('Invalid JSON file.', 'error');
                }
            };
            reader.onerror = () => {
                 showStatusMessage('Failed to read the file.', 'error');
            };
            reader.readAsText(file);
        };
        
        const copyScope = (text, event) => {
            navigator.clipboard.writeText(text).then(() => {
                const button = event.target;
                const originalText = button.innerText;
                button.innerText = 'Copied!';
                setTimeout(() => {
                    button.innerText = originalText;
                }, 1500);
            }).catch(err => {
                showStatusMessage('Failed to copy scope.', 'error');
            });
        };
        
        const openTeamsPage = () => {
            if (config.value.ccaas.host) {
                window.open(`https://${config.value.ccaas.host}/teams/setting`, '_blank');
            } else {
                showStatusMessage('Please enter a CCaaS Host first.', 'error');
            }
        };
        
        const showHelp = (title, content) => {
            helpModal.value = { show: true, title, content };
        };

        onMounted(() => {
            fetchMe();
            fetchRuns();
            fetchConfig();
        });

        return {
            config,
            ccaasDetails,
            directoryGroups,
            jobs,
            fileInput,
            isLoading,
            isSaving,
            isSyncing,
            isFetchingDetails,
            isFetchingGroups,
            isTestingConnection,
            isLoadingJobs,
            isProcessingJob,
            isFetchingSchemeErrors,
            statusMessage,
            testResultModal,
            showGcpHelpModal,
            showSyncModal,
            syncResultModal,
            runs,
            isLoadingRuns,
            fetchRuns,
            runOutcomeClass,
            me,
            isAdmin,
            confirmLargeDeactivation,
            helpModal,
            jobsPagination,
            totalPages,
            paginatedJobs,
            nextPage,
            prevPage,
            changePerPage,
            fetchConfig,
            saveConfig,
            runManualSync,
            getCcaasDetails,
            getDirectoryGroups,
            testCcaasConnection,
            testDirectoryConnection,
            fetchJobs,
            addMapping,
            removeMapping,
            addRule,
            removeRule,
            parseCcaasHost,
            getStatusColor,
            toggleJob,
            triggerFilePicker,
            handleFileImport,
            copyScope,
            proceedJob,
            openTeamsPage,
            showHelp
        };
    }
}).mount('#app');
