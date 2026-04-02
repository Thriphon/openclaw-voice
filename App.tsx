import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  SafeAreaView,
  StatusBar,
  Animated,
} from 'react-native';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Types
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface Config {
  serverUrl: string;
  token: string;
  sessionKey: string;
  voice: string;
}

const AVAILABLE_VOICES = [
  { id: 'nova', name: 'Nova', description: 'Warm female' },
  { id: 'alloy', name: 'Alloy', description: 'Neutral balanced' },
  { id: 'echo', name: 'Echo', description: 'Smooth male' },
  { id: 'fable', name: 'Fable', description: 'British accent' },
  { id: 'onyx', name: 'Onyx', description: 'Deep male' },
  { id: 'shimmer', name: 'Shimmer', description: 'Soft female' },
  { id: 'ash', name: 'Ash', description: 'Clear neutral' },
  { id: 'coral', name: 'Coral', description: 'Friendly warm' },
  { id: 'sage', name: 'Sage', description: 'Calm wise' },
];

// Main App
export default function App() {
  // State
  const [isConfigured, setIsConfigured] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
  // Audio queue for sequential playback
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  
  // Reconnect state
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const shouldReconnectRef = useRef(true);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  // Pulse animation for recording
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const loadConfig = async () => {
    try {
      const serverUrl = await AsyncStorage.getItem('serverUrl');
      const token = await AsyncStorage.getItem('token');
      const sessionKey = await AsyncStorage.getItem('sessionKey');
      const voice = await AsyncStorage.getItem('voice');
      
      if (serverUrl && token) {
        setConfig({
          serverUrl,
          token,
          sessionKey: sessionKey || 'voice:mobile',
          voice: voice || 'nova',
        });
        setIsConfigured(true);
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  };

  const saveConfig = async (newConfig: Config) => {
    try {
      console.log('Saving config...', { serverUrl: newConfig.serverUrl?.substring(0, 30), hasToken: !!newConfig.token });
      await AsyncStorage.setItem('serverUrl', newConfig.serverUrl || '');
      console.log('Saved serverUrl');
      await AsyncStorage.setItem('token', newConfig.token || '');
      console.log('Saved token');
      await AsyncStorage.setItem('sessionKey', newConfig.sessionKey || 'voice:mobile');
      console.log('Saved sessionKey');
      await AsyncStorage.setItem('voice', newConfig.voice || 'nova');
      console.log('Saved voice');
      
      // Small delay to ensure storage is committed before state change
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setConfig(newConfig);
      // Another small delay before switching screens
      await new Promise(resolve => setTimeout(resolve, 50));
      setIsConfigured(true);
      console.log('Config saved successfully!');
    } catch (e: any) {
      console.error('Failed to save config:', e);
      Alert.alert('Error', `Failed to save configuration.\n\nDetails: ${e.message || e.toString()}\n\nPlease try again.`);
    }
  };

  const changeVoice = async (voice: string) => {
    if (!config) return;
    const newConfig = { ...config, voice };
    await AsyncStorage.setItem('voice', voice);
    setConfig(newConfig);
  };

  const connect = useCallback(async () => {
    if (!config) return;
    
    // Enable auto-reconnect
    shouldReconnectRef.current = true;

    try {
      // Request audio permissions
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Microphone access is needed for voice chat');
        return;
      }

      // Configure audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });

      // Connect WebSocket
      // Server expects /ws path for WebSocket
      const baseUrl = config.serverUrl.replace('/api/voice', '').replace(/^http/, 'ws');
      const wsUrl = baseUrl + '/api/voice/ws';
      console.log('Connecting to:', wsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttemptsRef.current = 0; // Reset on successful connect
        setError(null);
        // Send auth
        ws.send(JSON.stringify({
          type: 'auth',
          token: config.token,
          sessionKey: config.sessionKey,
        }));
      };

      ws.onmessage = async (event) => {
        // Check if it's binary audio data
        if (typeof event.data !== 'string') {
          console.log('Received binary audio data:', event.data.byteLength || event.data.size, 'bytes');
          await playAudio(event.data);
          return;
        }
        
        // JSON message
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        setError('Connection error');
        setIsConnected(false);
      };

      ws.onclose = () => {
        console.log('WebSocket closed');
        setIsConnected(false);
        wsRef.current = null;
        
        // Auto-reconnect if not intentionally disconnected
        if (shouldReconnectRef.current && reconnectAttemptsRef.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1})`);
          setError(`Connection lost. Reconnecting...`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, delay);
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          setError('Connection lost. Tap Connect to retry.');
        }
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('Connection failed:', e);
      setError('Failed to connect');
    }
  }, [config]);

  const disconnect = () => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setIsConnected(false);
    setError(null);
  };

  const logout = () => {
    Alert.alert(
      'Logout',
      'This will clear your settings. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: () => {
            // Run logout synchronously first, then async cleanup
            disconnect();
            setConfig(null);
            setIsConfigured(false);
            setMessages([]);
            // Clear storage in background
            AsyncStorage.multiRemove(['serverUrl', 'token', 'sessionKey', 'voice'])
              .catch(e => console.error('Failed to clear storage:', e));
          },
        },
      ]
    );
  };

  const handleMessage = (data: any) => {
    switch (data.type) {
      case 'authenticated':
        setIsConnected(true);
        setError(null);
        break;

      case 'auth_error':
        setError(data.message || 'Authentication failed');
        wsRef.current?.close();
        break;

      case 'transcript':
        setCurrentTranscript(data.text);
        break;

      case 'transcript_final':
        addMessage('user', data.text);
        setCurrentTranscript('');
        setIsProcessing(true);
        break;

      case 'response_start':
        setIsProcessing(false);
        setIsSpeaking(true);
        break;

      case 'response_text':
        // Streaming text response
        updateLastAssistantMessage(data.text, data.final);
        break;

      case 'response_end':
        setIsSpeaking(false);
        break;

      case 'error':
        setError(data.message);
        setIsProcessing(false);
        setIsSpeaking(false);
        break;
    }
  };

  const addMessage = (role: 'user' | 'assistant', content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role,
        content,
        timestamp: new Date(),
      },
    ]);
  };

  const updateLastAssistantMessage = (content: string, isFinal: boolean) => {
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg?.role === 'assistant' && !isFinal) {
        // Update existing
        return [
          ...prev.slice(0, -1),
          { ...lastMsg, content: lastMsg.content + content },
        ];
      } else if (isFinal) {
        // Final message
        return prev;
      } else {
        // Start new assistant message
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content,
            timestamp: new Date(),
          },
        ];
      }
    });
  };

  // Convert audio data to base64 URI
  const audioToBase64 = async (audioData: Blob | ArrayBuffer): Promise<string | null> => {
    try {
      if (audioData instanceof ArrayBuffer) {
        const bytes = new Uint8Array(audioData);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return 'data:audio/mpeg;base64,' + btoa(binary);
      } else if (audioData instanceof Blob) {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(audioData);
        });
      }
      return null;
    } catch (e) {
      console.error('Failed to convert audio:', e);
      return null;
    }
  };

  // Process audio queue sequentially
  const processAudioQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);

    // Set audio mode for playback
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });

    while (audioQueueRef.current.length > 0) {
      const base64 = audioQueueRef.current.shift()!;
      
      try {
        // Unload previous sound
        if (soundRef.current) {
          try {
            await soundRef.current.unloadAsync();
          } catch (e) {}
          soundRef.current = null;
        }

        // Create and play sound
        const { sound } = await Audio.Sound.createAsync(
          { uri: base64 },
          { shouldPlay: true }
        );
        soundRef.current = sound;

        // Wait for playback to complete
        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              resolve();
            }
          });
        });

        // No gap needed - sentences flow naturally
        
      } catch (e) {
        console.error('Failed to play audio chunk:', e);
      }
    }

    isPlayingRef.current = false;
    setIsSpeaking(false);
    
    // Clean up last sound
    if (soundRef.current) {
      try {
        await soundRef.current.unloadAsync();
      } catch (e) {}
      soundRef.current = null;
    }
  };

  // Queue audio for playback
  const playAudio = async (audioData: Blob | ArrayBuffer) => {
    const base64 = await audioToBase64(audioData);
    if (base64) {
      console.log('Queuing audio chunk, queue size:', audioQueueRef.current.length + 1);
      audioQueueRef.current.push(base64);
      processAudioQueue();
    }
  };

  const startRecording = async () => {
    try {
      setError(null);

      // Check if connected
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setError('Not connected');
        return;
      }

      // Stop any playing audio first
      if (soundRef.current) {
        try {
          await soundRef.current.stopAsync();
          await soundRef.current.unloadAsync();
        } catch (e) {
          // Ignore errors when stopping
        }
        soundRef.current = null;
      }

      // Request permissions
      console.log('Requesting permissions...');
      const permResponse = await Audio.requestPermissionsAsync();
      if (permResponse.status !== 'granted') {
        setError('Microphone permission required');
        return;
      }

      // Set audio mode for recording
      console.log('Setting audio mode...');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      // Use the preset - more reliable than custom options
      console.log('Creating recording...');
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      console.log('Recording started!');
      recordingRef.current = recording;
      setIsRecording(true);

      // Notify server
      wsRef.current.send(JSON.stringify({ type: 'recording_start' }));
    } catch (e: any) {
      console.error('Failed to start recording:', e);
      setError(`Recording error: ${e.message}`);
    }
  };

  const stopRecording = async () => {
    try {
      if (!recordingRef.current) return;

      setIsRecording(false);
      setIsProcessing(true);

      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (uri && wsRef.current?.readyState === WebSocket.OPEN) {
        // Read audio file and send
        const response = await fetch(uri);
        const blob = await response.blob();
        
        // Convert to base64 for sending
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          wsRef.current?.send(JSON.stringify({
            type: 'audio',
            data: base64,
            format: Platform.OS === 'web' ? 'webm' : 'm4a',
            voice: config?.voice || 'nova',
          }));
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) {
      console.error('Failed to stop recording:', e);
      setError('Failed to process recording');
      setIsProcessing(false);
    }
  };

  // Config screen
  if (!isConfigured) {
    return <ConfigScreen onSave={saveConfig} />;
  }

  // Main screen
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setShowSettings(true)}>
          <Text style={styles.headerTitle}>🦉 Thriphon</Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isConnected ? '#4CAF50' : '#666' },
            ]}
          />
          <TouchableOpacity
            onPress={isConnected ? disconnect : connect}
            style={styles.connectButton}
          >
            <Text style={styles.connectButtonText}>
              {isConnected ? 'Disconnect' : 'Connect'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Modal */}
      {showSettings && (
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsModal}>
            <Text style={styles.settingsTitle}>⚙️ Settings</Text>
            
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Server</Text>
              <Text style={styles.settingsValue}>{config?.serverUrl}</Text>
            </View>
            
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Session</Text>
              <Text style={styles.settingsValue}>{config?.sessionKey}</Text>
            </View>

            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Status</Text>
              <Text style={[styles.settingsValue, { color: isConnected ? '#4CAF50' : '#ff6b6b' }]}>
                {isConnected ? '● Connected' : '○ Disconnected'}
              </Text>
            </View>

            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Voice</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.voiceSelector}>
                {AVAILABLE_VOICES.map((v) => (
                  <TouchableOpacity
                    key={v.id}
                    style={[
                      styles.voiceOption,
                      config?.voice === v.id && styles.voiceOptionSelected,
                    ]}
                    onPress={() => changeVoice(v.id)}
                  >
                    <Text style={[
                      styles.voiceOptionName,
                      config?.voice === v.id && styles.voiceOptionNameSelected,
                    ]}>{v.name}</Text>
                    <Text style={styles.voiceOptionDesc}>{v.description}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => {
                setMessages([]);
                setShowSettings(false);
              }}
            >
              <Text style={styles.settingsButtonText}>Clear Chat History</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.settingsButton, styles.logoutButton]}
              onPress={() => {
                setShowSettings(false);
                logout();
              }}
            >
              <Text style={styles.settingsButtonText}>Logout & Reset</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowSettings(false)}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateEmoji}>🦉</Text>
            <Text style={styles.emptyStateText}>
              {isConnected
                ? 'Hold the button to talk'
                : 'Tap Connect to start'}
            </Text>
          </View>
        )}
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              styles.message,
              msg.role === 'user' ? styles.userMessage : styles.assistantMessage,
            ]}
          >
            <Text
              style={[
                styles.messageText,
                msg.role === 'user'
                  ? styles.userMessageText
                  : styles.assistantMessageText,
              ]}
            >
              {msg.content}
            </Text>
          </View>
        ))}
        {currentTranscript && (
          <View style={[styles.message, styles.userMessage, styles.transcribing]}>
            <Text style={styles.userMessageText}>{currentTranscript}...</Text>
          </View>
        )}
        {isProcessing && (
          <View style={[styles.message, styles.assistantMessage]}>
            <Text style={styles.assistantMessageText}>Thinking...</Text>
          </View>
        )}
      </ScrollView>

      {/* Push to talk button */}
      <View style={styles.controls}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            onPressIn={startRecording}
            onPressOut={stopRecording}
            disabled={!isConnected || isProcessing || isSpeaking}
            style={[
              styles.recordButton,
              isRecording && styles.recordButtonActive,
              (!isConnected || isProcessing || isSpeaking) &&
                styles.recordButtonDisabled,
            ]}
          >
            <Text style={styles.recordButtonIcon}>
              {isRecording ? '🔴' : isSpeaking ? '🔊' : isProcessing ? '⏳' : '🎤'}
            </Text>
            <Text style={styles.recordButtonText}>
              {isRecording
                ? 'Listening...'
                : isSpeaking
                ? 'Speaking...'
                : isProcessing
                ? 'Processing...'
                : 'Hold to Talk'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

// Config Screen Component
function ConfigScreen({ onSave }: { onSave: (config: Config) => void }) {
  const [serverUrl, setServerUrl] = useState('https://thriphon.cloud/api/voice');
  const [token, setToken] = useState('');
  const [sessionKey, setSessionKey] = useState('voice:mobile');

  const handleSave = () => {
    if (!serverUrl || !token) {
      Alert.alert('Error', 'Server URL and Token are required');
      return;
    }
    onSave({ serverUrl, token, sessionKey });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.configContainer}>
        <Text style={styles.configTitle}>🦉 OpenClaw Voice</Text>
        <Text style={styles.configSubtitle}>Connect to your assistant</Text>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://your-server.com/api/voice"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Gateway Token</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Your gateway token"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Session Key (optional)</Text>
          <TextInput
            style={styles.input}
            value={sessionKey}
            onChangeText={setSessionKey}
            placeholder="voice:mobile"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
          <Text style={styles.saveButtonText}>Connect</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    paddingTop: Platform.OS === 'android' ? 45 : 15,
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  connectButton: {
    paddingHorizontal: 15,
    paddingVertical: 8,
    backgroundColor: '#4a4a6a',
    borderRadius: 20,
  },
  connectButtonText: {
    color: '#fff',
    fontSize: 14,
  },
  errorBanner: {
    backgroundColor: '#ff4444',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  errorText: {
    color: '#fff',
    textAlign: 'center',
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: 20,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyStateEmoji: {
    fontSize: 60,
    marginBottom: 20,
  },
  emptyStateText: {
    color: '#888',
    fontSize: 16,
  },
  message: {
    maxWidth: '80%',
    marginBottom: 12,
    padding: 14,
    borderRadius: 18,
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#5c6bc0',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#2d2d44',
  },
  transcribing: {
    opacity: 0.7,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#fff',
  },
  assistantMessageText: {
    color: '#e0e0e0',
  },
  controls: {
    paddingVertical: 30,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'android' ? 50 : 30,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2d2d44',
  },
  recordButton: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#4a4a6a',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  recordButtonActive: {
    backgroundColor: '#e53935',
  },
  recordButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.6,
  },
  recordButtonIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Config screen styles
  configContainer: {
    flex: 1,
    padding: 30,
    justifyContent: 'center',
  },
  configTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 10,
  },
  configSubtitle: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginBottom: 40,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    color: '#aaa',
    marginBottom: 8,
    fontSize: 14,
  },
  input: {
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 16,
  },
  saveButton: {
    backgroundColor: '#5c6bc0',
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: 20,
  },
  saveButtonText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '600',
  },
  // Settings modal styles
  settingsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  settingsModal: {
    backgroundColor: '#2d2d44',
    borderRadius: 20,
    padding: 24,
    width: '85%',
    maxWidth: 400,
  },
  settingsTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 20,
  },
  settingsInfo: {
    marginBottom: 16,
  },
  settingsLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 4,
  },
  settingsValue: {
    color: '#fff',
    fontSize: 14,
  },
  settingsButton: {
    backgroundColor: '#4a4a6a',
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 12,
  },
  settingsButtonText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 16,
  },
  logoutButton: {
    backgroundColor: '#c0392b',
  },
  closeButton: {
    marginTop: 16,
    paddingVertical: 12,
  },
  closeButtonText: {
    color: '#888',
    textAlign: 'center',
    fontSize: 16,
  },
  voiceSelector: {
    marginTop: 8,
    marginHorizontal: -8,
  },
  voiceOption: {
    backgroundColor: '#3d3d5c',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 4,
    minWidth: 100,
    alignItems: 'center',
  },
  voiceOptionSelected: {
    backgroundColor: '#5c6bc0',
  },
  voiceOptionName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  voiceOptionNameSelected: {
    color: '#fff',
  },
  voiceOptionDesc: {
    color: '#aaa',
    fontSize: 11,
    marginTop: 2,
  },
});
